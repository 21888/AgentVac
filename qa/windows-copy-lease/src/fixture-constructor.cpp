#ifndef _WIN32
#error This source-only fixture constructor requires the Windows SDK. Native execution is NOT_RUN.
#endif
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <aclapi.h>
#include <bcrypt.h>
#include <algorithm>
#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <memory>
#include <string>
#include <vector>
#include "../include/core.hpp"
#include "../include/inherited-context.hpp"

// A separate, creation-only research executable. It never invokes the helper,
// requests a different token, or changes an existing object's security.
namespace {
constexpr DWORD kSoftDeadlineMs = 4500, kHardDeadlineMs = 5000;
constexpr DWORD kFullControl = 0x001f01ff, kOrdinaryRead = 0x00120089;
constexpr std::size_t kResponseBytes = 44, kSuffixBytes = 32;
static_assert(FILE_ALL_ACCESS == kFullControl, "Expected normalized full-control mask.");
static_assert(FILE_GENERIC_READ == kOrdinaryRead, "Expected normalized ordinary-read mask.");
enum class Reason : std::uint8_t { None = 0, Request = 1, Peer = 2,
  Context = 3, Unavailable = 4, Locality = 5, Descriptor = 6,
  Create = 7, Verify = 8, Deadline = 9, Internal = 10 };
struct Report {
  bool contextVerified = false, elevated = false;
  std::array<char, kSuffixBytes> suffix{};
};
struct Close {
  void operator()(void* handle) const {
    if (handle && handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
  }
};
using Handle = std::unique_ptr<void, Close>;
bool valid(const Handle& handle) { return handle && handle.get() != INVALID_HANDLE_VALUE; }
struct LocalFreeDeleter { void operator()(void* p) const { if (p) LocalFree(p); } };
using Local = std::unique_ptr<void, LocalFreeDeleter>;
std::atomic<HANDLE> gCancel{nullptr};
ULONGLONG gStarted = 0;
BOOL WINAPI control(DWORD) {
  const HANDLE cancel = gCancel.load();
  if (cancel) SetEvent(cancel);
  return TRUE;
}
bool stopped() {
  const HANDLE cancel = gCancel.load();
  return GetTickCount64() - gStarted >= kSoftDeadlineMs ||
    !cancel || WaitForSingleObject(cancel, 0) != WAIT_TIMEOUT;
}
DWORD WINAPI hardDeadline(void* done) {
  const ULONGLONG elapsed = GetTickCount64() - gStarted;
  const DWORD remaining = elapsed >= kHardDeadlineMs ? 0 :
    kHardDeadlineMs - static_cast<DWORD>(elapsed);
  if (WaitForSingleObject(done, remaining) != WAIT_OBJECT_0)
    TerminateProcess(GetCurrentProcess(), 124);
  return 0;
}

enum class PipeRead { Bytes, Eof, Failed, Stopped };
PipeRead readAvailable(HANDLE pipe, void* output, DWORD capacity, DWORD& got) {
  got = 0;
  for (;;) {
    if (stopped()) return PipeRead::Stopped;
    DWORD available = 0;
    if (!PeekNamedPipe(pipe, nullptr, 0, nullptr, &available, nullptr))
      return GetLastError() == ERROR_BROKEN_PIPE ? PipeRead::Eof : PipeRead::Failed;
    if (available) {
      const DWORD wanted = std::min(capacity, available);
      if (!ReadFile(pipe, output, wanted, &got, nullptr) || !got) return PipeRead::Failed;
      return PipeRead::Bytes;
    }
    Sleep(5);
  }
}
bool readExact(HANDLE pipe, void* output, DWORD size) {
  auto* at = static_cast<std::uint8_t*>(output);
  while (size) {
    DWORD got = 0;
    if (readAvailable(pipe, at, size, got) != PipeRead::Bytes) return false;
    at += got; size -= got;
  }
  return true;
}
bool ended(HANDLE pipe) {
  std::uint8_t extra = 0; DWORD got = 0;
  return readAvailable(pipe, &extra, 1, got) == PipeRead::Eof;
}
bool same(const std::wstring& a, const std::wstring& b) {
  return a.size() == b.size() &&
    CompareStringOrdinal(a.c_str(), static_cast<int>(a.size()),
      b.c_str(), static_cast<int>(b.size()), TRUE) == CSTR_EQUAL;
}
std::u16string utf16(const std::wstring& value) {
  static_assert(sizeof(wchar_t) == sizeof(char16_t));
  return {value.begin(), value.end()};
}
std::wstring wide(const std::u16string& value) { return {value.begin(), value.end()}; }
bool mapping(const std::wstring& drive, std::wstring& output) {
  std::array<wchar_t, 32768> buffer{};
  const DWORD count = QueryDosDeviceW(drive.c_str(), buffer.data(), static_cast<DWORD>(buffer.size()));
  if (!count || count >= buffer.size()) return false;
  const auto end = std::find(buffer.begin(), buffer.begin() + count, L'\0');
  if (end == buffer.begin() || end == buffer.begin() + count) return false;
  output.assign(buffer.begin(), end);
  return avm::nativeMapping(utf16(output));
}
bool finalPath(HANDLE handle, const std::wstring& expected) {
  std::array<wchar_t, avm::kMaxUtf16 + 256> buffer{};
  const DWORD count = GetFinalPathNameByHandleW(handle, buffer.data(),
    static_cast<DWORD>(buffer.size()), FILE_NAME_OPENED | VOLUME_NAME_NT);
  if (!count || count >= buffer.size()) return false;
  std::wstring actual(buffer.data(), count), wanted = expected;
  if (actual.size() > 1 && actual.back() == L'\\') actual.pop_back();
  if (wanted.size() > 1 && wanted.back() == L'\\') wanted.pop_back();
  return same(actual, wanted);
}
bool metadata(HANDLE handle, const std::wstring& expected, bool directory,
              bool emptyFile, BY_HANDLE_FILE_INFORMATION* returned = nullptr) {
  BY_HANDLE_FILE_INFORMATION info{};
  if (!GetFileInformationByHandle(handle, &info) || !finalPath(handle, expected) ||
      (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) ||
      (((info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) != directory) ||
      !info.nNumberOfLinks || (!directory && info.nNumberOfLinks != 1) ||
      (emptyFile && (info.nFileSizeHigh || info.nFileSizeLow))) return false;
  if (returned) *returned = info;
  return true;
}
struct Paths {
  std::wstring drive, device, directory, self;
  std::vector<Handle> ancestors;
};
bool derivePaths(Paths& paths) {
  std::array<wchar_t, avm::kMaxUtf16 + 1> module{};
  const DWORD count = GetModuleFileNameW(nullptr, module.data(), static_cast<DWORD>(module.size()));
  if (!count || count >= module.size()) return false;
  std::u16string canonical = utf16(std::wstring(module.data(), count));
  if (!avm::canonicalize(canonical)) return false;
  paths.self = wide(canonical); paths.drive = paths.self.substr(0, 2);
  const auto slash = paths.self.find_last_of(L'\\');
  if (slash == std::wstring::npos || slash <= 3) return false;
  paths.directory = paths.self.substr(0, slash);
  const std::wstring x64 = L"\\build\\windows-x64", arm64 = L"\\build\\windows-arm64";
  if (!((paths.directory.size() >= x64.size() &&
          same(paths.directory.substr(paths.directory.size() - x64.size()), x64)) ||
        (paths.directory.size() >= arm64.size() &&
          same(paths.directory.substr(paths.directory.size() - arm64.size()), arm64)))) return false;
  if (paths.directory.size() + 1 + 18 + kSuffixBytes + 1 + 7 + 1 + 9 > avm::kMaxUtf16)
    return false;
  return mapping(paths.drive, paths.device);
}
bool mappingUnchanged(const Paths& paths) {
  std::wstring now;
  return !stopped() && mapping(paths.drive, now) && now == paths.device;
}
bool pinAncestors(Paths& paths) {
  std::wstring expected = paths.device + L"\\";
  if (GetDriveTypeW((L"\\\\?\\GLOBALROOT" + expected).c_str()) != DRIVE_FIXED) return false;
  std::size_t at = 3;
  for (;;) {
    if (stopped()) return false;
    Handle handle(CreateFileW((L"\\\\?\\GLOBALROOT" + expected).c_str(),
      FILE_READ_ATTRIBUTES, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    if (!valid(handle) || !metadata(handle.get(), expected, true, false)) return false;
    paths.ancestors.push_back(std::move(handle));
    if (at > paths.directory.size()) break;
    const auto end = paths.directory.find(L'\\', at);
    const auto part = paths.directory.substr(at, end == std::wstring::npos ? end : end - at);
    if (part.empty()) return false;
    if (expected.back() != L'\\') expected += L'\\';
    expected += part;
    at = end == std::wstring::npos ? paths.directory.size() + 1 : end + 1;
  }
  // Pin the executable's metadata identity too; no binary contents are opened.
  const std::wstring self = paths.device + paths.self.substr(2);
  Handle executable(CreateFileW((L"\\\\?\\GLOBALROOT" + self).c_str(),
    FILE_READ_ATTRIBUTES, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
    FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (!valid(executable) || !metadata(executable.get(), self, false, false)) return false;
  paths.ancestors.push_back(std::move(executable));
  return mappingUnchanged(paths);
}

struct Descriptor {
  SECURITY_DESCRIPTOR value{};
  std::vector<std::uint8_t> acl;
  SECURITY_ATTRIBUTES attributes{sizeof(SECURITY_ATTRIBUTES), nullptr, FALSE};
  bool initialize(PSID owner, PSID system, PSID admins, PSID everyone, bool directory, bool broad) {
    if (!owner || !IsValidSid(owner) || !IsValidSid(system) || !IsValidSid(admins) || !IsValidSid(everyone)) return false;
    const std::array<PSID, 4> principals{owner, system, admins, everyone};
    const std::size_t count = broad ? 4 : 3;
    DWORD bytes = sizeof(ACL);
    for (std::size_t i = 0; i < count; ++i)
      bytes += static_cast<DWORD>(offsetof(ACCESS_ALLOWED_ACE, SidStart)) + GetLengthSid(principals[i]);
    if (bytes > 65535) return false;
    acl.resize(bytes);
    auto* dacl = reinterpret_cast<PACL>(acl.data());
    if (!InitializeAcl(dacl, bytes, ACL_REVISION)) return false;
    const DWORD flags = directory ? OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE : 0;
    for (std::size_t i = 0; i < count; ++i)
      if (!AddAccessAllowedAceEx(dacl, ACL_REVISION, flags,
          i == 3 ? kOrdinaryRead : kFullControl, principals[i])) return false;
    // All setters below address only this in-memory descriptor, never an object.
    if (!InitializeSecurityDescriptor(&value, SECURITY_DESCRIPTOR_REVISION) ||
        !SetSecurityDescriptorOwner(&value, owner, FALSE) ||
        !SetSecurityDescriptorGroup(&value, owner, FALSE) ||
        !SetSecurityDescriptorDacl(&value, TRUE, dacl, FALSE) ||
        !SetSecurityDescriptorControl(&value, SE_DACL_PROTECTED, SE_DACL_PROTECTED) ||
        !IsValidSecurityDescriptor(&value)) return false;
    attributes.lpSecurityDescriptor = &value;
    return true;
  }
};
struct Descriptors {
  alignas(DWORD) std::array<std::uint8_t, SECURITY_MAX_SID_SIZE> system{}, admins{}, everyone{};
  Descriptor privateDirectory, broadDirectory, privateFile, broadFile;
  bool initialize(PSID owner) {
    DWORD systemBytes = static_cast<DWORD>(system.size()), adminBytes = static_cast<DWORD>(admins.size()),
      everyoneBytes = static_cast<DWORD>(everyone.size());
    if (!CreateWellKnownSid(WinLocalSystemSid, nullptr, system.data(), &systemBytes) ||
        !CreateWellKnownSid(WinBuiltinAdministratorsSid, nullptr, admins.data(), &adminBytes) ||
        !CreateWellKnownSid(WinWorldSid, nullptr, everyone.data(), &everyoneBytes)) return false;
    return privateDirectory.initialize(owner, system.data(), admins.data(), everyone.data(), true, false) &&
      broadDirectory.initialize(owner, system.data(), admins.data(), everyone.data(), true, true) &&
      privateFile.initialize(owner, system.data(), admins.data(), everyone.data(), false, false) &&
      broadFile.initialize(owner, system.data(), admins.data(), everyone.data(), false, true);
  }
};
bool securityMatches(HANDLE handle, PSID expectedOwner, bool directory, bool broad,
                     const Descriptors& descriptors) {
  PSECURITY_DESCRIPTOR raw = nullptr; PSID owner = nullptr, group = nullptr; PACL acl = nullptr;
  const DWORD status = GetSecurityInfo(handle, SE_FILE_OBJECT,
    OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
    &owner, &group, &acl, nullptr, &raw);
  Local descriptor(raw);
  if (status != ERROR_SUCCESS || !raw || !IsValidSecurityDescriptor(raw) ||
      !owner || !group || !IsValidSid(owner) || !IsValidSid(group) ||
      !EqualSid(owner, expectedOwner) || !EqualSid(group, expectedOwner) || !acl || !IsValidAcl(acl)) return false;
  SECURITY_DESCRIPTOR_CONTROL controlBits{}; DWORD revision = 0;
  if (!GetSecurityDescriptorControl(raw, &controlBits, &revision) || revision != SECURITY_DESCRIPTOR_REVISION ||
      !(controlBits & SE_DACL_PRESENT) || !(controlBits & SE_DACL_PROTECTED) ||
      (controlBits & (SE_DACL_DEFAULTED | SE_OWNER_DEFAULTED | SE_GROUP_DEFAULTED))) return false;
  const std::array<PSID, 4> principals{expectedOwner,
    const_cast<std::uint8_t*>(descriptors.system.data()),
    const_cast<std::uint8_t*>(descriptors.admins.data()),
    const_cast<std::uint8_t*>(descriptors.everyone.data())};
  const DWORD count = broad ? 4 : 3;
  ACL_SIZE_INFORMATION info{};
  if (!GetAclInformation(acl, &info, sizeof(info), AclSizeInformation) || info.AceCount != count ||
      info.AclBytesInUse > acl->AclSize || acl->AclRevision != ACL_REVISION) return false;
  const BYTE flags = directory ? static_cast<BYTE>(OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE) : 0;
  for (DWORD i = 0; i < count; ++i) {
    void* pointer = nullptr;
    if (!GetAce(acl, i, &pointer) || !pointer) return false;
    const auto* ace = static_cast<const ACCESS_ALLOWED_ACE*>(pointer);
    const DWORD sidBytes = GetLengthSid(principals[i]);
    if (ace->Header.AceType != ACCESS_ALLOWED_ACE_TYPE || ace->Header.AceFlags != flags ||
        ace->Header.AceSize != offsetof(ACCESS_ALLOWED_ACE, SidStart) + sidBytes ||
        ace->Mask != (i == 3 ? kOrdinaryRead : kFullControl)) return false;
    PSID sid = const_cast<DWORD*>(&ace->SidStart);
    if (!IsValidSid(sid) || GetLengthSid(sid) != sidBytes || !EqualSid(sid, principals[i])) return false;
  }
  return true;
}
struct Created {
  Handle handle;
  std::wstring expected;
  bool directory = false, broad = false;
  BY_HANDLE_FILE_INFORMATION identity{};
};
bool sameIdentity(const BY_HANDLE_FILE_INFORMATION& a, const BY_HANDLE_FILE_INFORMATION& b) {
  return a.dwVolumeSerialNumber == b.dwVolumeSerialNumber &&
    a.nFileIndexHigh == b.nFileIndexHigh && a.nFileIndexLow == b.nFileIndexLow;
}
Reason createObject(const Paths& paths, const std::wstring& expected, bool directory,
                    bool broad, Descriptor& descriptor, PSID owner,
                    const Descriptors& descriptors, std::vector<Created>& created) {
  if (!mappingUnchanged(paths)) return stopped() ? Reason::Deadline : Reason::Locality;
  const std::wstring native = L"\\\\?\\GLOBALROOT" + expected;
  Handle handle;
  if (directory) {
    // CreateDirectory has create-new semantics. Any collision is a hard failure.
    // It does not return a handle: the create-to-pin gap is documented, not hidden.
    if (!CreateDirectoryW(native.c_str(), &descriptor.attributes)) return Reason::Create;
    handle.reset(CreateFileW(native.c_str(), FILE_READ_ATTRIBUTES | READ_CONTROL,
      FILE_SHARE_READ, nullptr, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  } else {
    handle.reset(CreateFileW(native.c_str(), FILE_READ_ATTRIBUTES | READ_CONTROL,
      FILE_SHARE_READ, &descriptor.attributes, CREATE_NEW,
      FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    if (!valid(handle)) return Reason::Create;
  }
  Created item;
  item.handle = std::move(handle); item.expected = expected;
  item.directory = directory; item.broad = broad;
  if (!valid(item.handle) || !metadata(item.handle.get(), expected, directory, !directory, &item.identity) ||
      !securityMatches(item.handle.get(), owner, directory, broad, descriptors)) return Reason::Verify;
  created.push_back(std::move(item));
  return Reason::None;
}
Reason run(Report& report) {
  const HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  std::array<std::uint8_t, 12> frame{};
  if (!readExact(input, frame.data(), static_cast<DWORD>(frame.size())) ||
      avm::u32(frame.data()) != 8 || std::memcmp(frame.data() + 4, "AVF1", 4)) return Reason::Request;
  const DWORD expectedCallerPid = avm::u32(frame.data() + 8);
  if (!expectedCallerPid) return Reason::Request;
  avm_inherited::BoundCaller caller;
  const auto outcome = avm_inherited::bindCaller(input, expectedCallerPid, caller);
  switch (outcome) {
    case avm_inherited::Outcome::Verified: break;
    case avm_inherited::Outcome::PeerRejected: return Reason::Peer;
    case avm_inherited::Outcome::ContextRejected: return Reason::Context;
    default: return Reason::Unavailable;
  }
  // No filesystem metadata probe or create occurs before the bound-context gate.
  report.contextVerified = true; report.elevated = caller.elevated;
  if (stopped()) return Reason::Deadline;
  // The caller holds stdin connected until this ack so that peer binding never
  // relies on GetNamedPipeServerProcessId succeeding after the writer closes.
  constexpr char acknowledgement[] = "AVH2";
  DWORD acknowledged = 0;
  if (!WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), acknowledgement, 4, &acknowledged, nullptr) ||
      acknowledged != 4) return Reason::Unavailable;
  if (!ended(input)) return stopped() ? Reason::Deadline : Reason::Request;
  Paths paths;
  if (!derivePaths(paths) || !pinAncestors(paths)) return stopped() ? Reason::Deadline : Reason::Locality;
  Descriptors descriptors;
  if (!descriptors.initialize(caller.userSid())) return Reason::Descriptor;
  std::array<std::uint8_t, 16> random{};
  if (BCryptGenRandom(nullptr, random.data(), static_cast<ULONG>(random.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0)
    return Reason::Unavailable;
  constexpr char hex[] = "0123456789abcdef";
  std::array<char, kSuffixBytes> suffix{};
  for (std::size_t i = 0; i < random.size(); ++i) {
    suffix[2 * i] = hex[random[i] >> 4]; suffix[2 * i + 1] = hex[random[i] & 15];
  }
  const std::wstring root = paths.device + paths.directory.substr(2) +
    L"\\inherited-fixture-" + std::wstring(suffix.begin(), suffix.end());
  std::vector<Created> created; created.reserve(5);
  const auto create = [&](const std::wstring& path, bool directory, bool broad, Descriptor& descriptor) {
    return createObject(paths, path, directory, broad, descriptor, caller.userSid(), descriptors, created);
  };
  Reason result = create(root, true, false, descriptors.privateDirectory);
  if (result != Reason::None) return result;
  result = create(root + L"\\private", true, false, descriptors.privateDirectory);
  if (result != Reason::None) return result;
  result = create(root + L"\\private\\empty.bin", false, false, descriptors.privateFile);
  if (result != Reason::None) return result;
  result = create(root + L"\\broad", true, true, descriptors.broadDirectory);
  if (result != Reason::None) return result;
  result = create(root + L"\\broad\\empty.bin", false, true, descriptors.broadFile);
  if (result != Reason::None) return result;
  for (const auto& item : created) {
    BY_HANDLE_FILE_INFORMATION identity{};
    if (stopped()) return Reason::Deadline;
    if (!metadata(item.handle.get(), item.expected, item.directory, !item.directory, &identity) ||
        !sameIdentity(item.identity, identity) ||
        !securityMatches(item.handle.get(), caller.userSid(), item.directory, item.broad, descriptors)) return Reason::Verify;
  }
  if (!mappingUnchanged(paths)) return stopped() ? Reason::Deadline : Reason::Locality;
  report.suffix = suffix;
  return Reason::None;
}
bool emit(Reason reason, const Report& report) {
  std::array<std::uint8_t, kResponseBytes> bytes{};
  std::memcpy(bytes.data(), "AVC1", 4);
  bytes[4] = reason == Reason::None ? 0 : 1;
  bytes[5] = static_cast<std::uint8_t>(reason);
  bytes[6] = report.contextVerified && report.elevated ? 1 : 0;
  if (reason == Reason::None) std::memcpy(bytes.data() + 8, report.suffix.data(), report.suffix.size());
  // The hard-stop thread also bounds a blocked pipe write. No file data is written.
  DWORD written = 0;
  return WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), bytes.data(), static_cast<DWORD>(bytes.size()),
    &written, nullptr) && written == bytes.size();
}
} // namespace

int main(int argc, char**) {
  SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
  gStarted = GetTickCount64();
  Handle done(CreateEventW(nullptr, TRUE, FALSE, nullptr)), cancel(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  if (!done || !cancel) return 125;
  gCancel = cancel.get();
  Handle watcher(CreateThread(nullptr, 0, hardDeadline, done.get(), 0, nullptr));
  if (!watcher) return 125;
  const BOOL controls = SetConsoleCtrlHandler(control, TRUE);
  const bool pipes = GetFileType(GetStdHandle(STD_INPUT_HANDLE)) == FILE_TYPE_PIPE &&
    GetFileType(GetStdHandle(STD_OUTPUT_HANDLE)) == FILE_TYPE_PIPE;
  Report report; Reason reason = Reason::Request;
  if (argc == 1 && pipes) {
    try { reason = run(report); } catch (...) { reason = Reason::Internal; }
  }
  if (stopped()) reason = Reason::Deadline;
  const bool sent = pipes && emit(reason, report);
  if (controls) SetConsoleCtrlHandler(control, FALSE);
  gCancel = nullptr;
  SetEvent(done.get()); WaitForSingleObject(watcher.get(), INFINITE);
  return sent && reason == Reason::None ? 0 : 125;
}
