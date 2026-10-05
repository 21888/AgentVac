#ifndef _WIN32
#error This source-only fixture launcher requires the Windows SDK. Native compilation/execution is NOT_RUN.
#endif
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <bcrypt.h>
#include <array>
#include <atomic>
#include <cstddef>
#include <cstring>
#include <memory>
#include "../include/core.hpp"
#include "reviewed-helper-binding.h"

#ifndef PROC_THREAD_ATTRIBUTE_JOB_LIST
#error A Windows 10 SDK with atomic process job assignment is required. No fallback is permitted.
#endif
#ifndef AGENTVAC_REVIEWED_HELPER_SHA256
#error The build must generate a reviewed-helper-binding.h with the exact helper SHA-256.
#endif

namespace {
constexpr char kHelperHash[] = AGENTVAC_REVIEWED_HELPER_SHA256;
static_assert(sizeof(kHelperHash) == 65, "A 64-character lowercase SHA-256 binding is mandatory.");
constexpr DWORD kDeadlineMs = 6000, kHardDeadlineMs = 7000;
constexpr DWORD kMaxBinary = 8u * 1024u * 1024u;
constexpr std::size_t kPrefixBytes = 32, kHelperFrameBytes = 4 + avm::kResponseSize;
enum class Reason : std::uint8_t { None = 0, Request = 1, Binding = 2, Fixture = 3,
  Token = 4, Desktop = 5, Launch = 6, Job = 7, ChildToken = 8,
  Deadline = 9, Pipe = 10, Response = 11 };
enum Evidence : DWORD { BoundHelper = 1, CandidateVerified = 2, ChildVerified = 4,
  JobContained = 8, ExitedClean = 16, ResponseValidated = 32 };
struct Report {
  DWORD candidateIntegrity = 0, childIntegrity = 0, evidence = 0;
  std::array<std::uint8_t, kHelperFrameBytes> frame{};
};
struct Close { void operator()(void* h) const { if (h && h != INVALID_HANDLE_VALUE) CloseHandle(h); } };
using Handle = std::unique_ptr<void, Close>;
bool valid(const Handle& h) { return h && h.get() != INVALID_HANDLE_VALUE; }
std::wstring wide(const std::u16string& s) { static_assert(sizeof(wchar_t) == sizeof(char16_t)); return {s.begin(), s.end()}; }
std::u16string utf16(const std::wstring& s) { return {s.begin(), s.end()}; }
bool same(const std::wstring& a, const std::wstring& b) {
  return a.size() == b.size() && CompareStringOrdinal(a.c_str(), static_cast<int>(a.size()), b.c_str(), static_cast<int>(b.size()), TRUE) == CSTR_EQUAL;
}
std::atomic<HANDLE> gCancel{nullptr};
ULONGLONG gStarted = 0;
BOOL WINAPI control(DWORD) { const HANDLE cancel = gCancel.load(); if (cancel) SetEvent(cancel); return TRUE; }
bool stopped() { return GetTickCount64() - gStarted >= kDeadlineMs || WaitForSingleObject(gCancel.load(), 0) != WAIT_TIMEOUT; }
DWORD WINAPI hardDeadline(void* done) {
  if (WaitForSingleObject(done, kHardDeadlineMs) != WAIT_OBJECT_0) TerminateProcess(GetCurrentProcess(), 124);
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
  while (size) { DWORD got = 0; if (readAvailable(pipe, at, size, got) != PipeRead::Bytes) return false; at += got; size -= got; }
  return true;
}
bool ended(HANDLE pipe) { std::uint8_t extra = 0; DWORD got = 0; return readAvailable(pipe, &extra, 1, got) == PipeRead::Eof; }
bool writeExact(HANDLE pipe, const void* input, DWORD size) {
  const auto* at = static_cast<const std::uint8_t*>(input);
  while (size) {
    if (stopped()) return false;
    DWORD written = 0;
    if (!WriteFile(pipe, at, size, &written, nullptr) || !written) return false;
    at += written; size -= written;
  }
  return true;
}

bool tokenBytes(HANDLE token, TOKEN_INFORMATION_CLASS type, std::vector<std::uint8_t>& bytes) {
  DWORD count = 0;
  if (GetTokenInformation(token, type, nullptr, 0, &count) || GetLastError() != ERROR_INSUFFICIENT_BUFFER || !count || count > 65536) return false;
  bytes.resize(count); DWORD returned = 0;
  return GetTokenInformation(token, type, bytes.data(), count, &returned) && returned == count;
}
template<class T> bool tokenValue(HANDLE token, TOKEN_INFORMATION_CLASS type, T& value) {
  DWORD count = 0;
  return GetTokenInformation(token, type, &value, sizeof(value), &count) && count == sizeof(value);
}
bool containedSid(const std::vector<std::uint8_t>& bytes, PSID sid) {
  const auto begin = reinterpret_cast<std::uintptr_t>(bytes.data()), at = reinterpret_cast<std::uintptr_t>(sid);
  if (at < begin || at - begin > bytes.size() || bytes.size() - (at - begin) < 8) return false;
  const auto* value = static_cast<const SID*>(sid);
  const std::size_t length = 8u + 4u * value->SubAuthorityCount;
  return avm::sidShape(value->Revision, value->SubAuthorityCount) && length <= bytes.size() - (at - begin) && IsValidSid(sid);
}
PSID userSid(std::vector<std::uint8_t>& bytes) {
  if (bytes.size() < sizeof(TOKEN_USER)) return nullptr;
  PSID sid = reinterpret_cast<TOKEN_USER*>(bytes.data())->User.Sid;
  return containedSid(bytes, sid) ? sid : nullptr;
}
bool integrity(HANDLE token, DWORD& rid) {
  std::vector<std::uint8_t> bytes;
  if (!tokenBytes(token, TokenIntegrityLevel, bytes) || bytes.size() < sizeof(TOKEN_MANDATORY_LABEL)) return false;
  const auto* label = reinterpret_cast<const TOKEN_MANDATORY_LABEL*>(bytes.data());
  if (!containedSid(bytes, label->Label.Sid) || !(label->Label.Attributes & SE_GROUP_INTEGRITY)) return false;
  const SID_IDENTIFIER_AUTHORITY mandatory = SECURITY_MANDATORY_LABEL_AUTHORITY;
  if (std::memcmp(GetSidIdentifierAuthority(label->Label.Sid), &mandatory, sizeof(mandatory)) || *GetSidSubAuthorityCount(label->Label.Sid) != 1) return false;
  rid = *GetSidSubAuthority(label->Label.Sid, 0); return true;
}
bool privileges(HANDLE token, bool candidate) {
  std::vector<std::uint8_t> bytes;
  if (!tokenBytes(token, TokenPrivileges, bytes) || bytes.size() < offsetof(TOKEN_PRIVILEGES, Privileges)) return false;
  const auto* values = reinterpret_cast<const TOKEN_PRIVILEGES*>(bytes.data());
  if (values->PrivilegeCount > (bytes.size() - offsetof(TOKEN_PRIVILEGES, Privileges)) / sizeof(LUID_AND_ATTRIBUTES)) return false;
  LUID notify{}, quota{}, assign{};
  if (!LookupPrivilegeValueW(nullptr, SE_CHANGE_NOTIFY_NAME, &notify) || !LookupPrivilegeValueW(nullptr, SE_INCREASE_QUOTA_NAME, &quota) || !LookupPrivilegeValueW(nullptr, SE_ASSIGNPRIMARYTOKEN_NAME, &assign)) return false;
  auto equals = [](const LUID& a, const LUID& b) { return a.LowPart == b.LowPart && a.HighPart == b.HighPart; };
  bool enabledQuota = false;
  for (DWORD i = 0; i < values->PrivilegeCount; ++i) {
    const auto& p = values->Privileges[i]; const bool enabled = (p.Attributes & SE_PRIVILEGE_ENABLED) != 0;
    if (candidate && enabled && !equals(p.Luid, notify)) return false;
    // CreateProcessAsUser can otherwise enable these caller privileges itself.
    if (!candidate && (equals(p.Luid, quota) || equals(p.Luid, assign)) && !enabled) return false;
    if (equals(p.Luid, quota) && enabled) enabledQuota = true;
  }
  return candidate || enabledQuota; // No privilege enabling, even an API's implicit enabling.
}
bool verifyToken(HANDLE token, PSID originalUser, DWORD expectedSession, DWORD& rid) {
  TOKEN_ELEVATION elevation{}; TOKEN_TYPE type{}; DWORD restricted = 0, ui = 0, session = 0;
  std::vector<std::uint8_t> groups, user;
  if (!tokenValue(token, TokenType, type) || type != TokenPrimary ||
      !tokenValue(token, TokenElevation, elevation) || elevation.TokenIsElevated ||
      !tokenValue(token, TokenHasRestrictions, restricted) || restricted != 1 ||
      !tokenValue(token, TokenUIAccess, ui) || ui || !tokenValue(token, TokenSessionId, session) || session != expectedSession ||
      !integrity(token, rid) || !rid || rid > SECURITY_MANDATORY_MEDIUM_RID || !privileges(token, true) ||
      !tokenBytes(token, TokenUser, user) || !userSid(user) || !EqualSid(originalUser, userSid(user)) ||
      !tokenBytes(token, TokenGroups, groups) || groups.size() < offsetof(TOKEN_GROUPS, Groups)) return false;
  const auto* values = reinterpret_cast<const TOKEN_GROUPS*>(groups.data());
  if (values->GroupCount > (groups.size() - offsetof(TOKEN_GROUPS, Groups)) / sizeof(SID_AND_ATTRIBUTES)) return false;
  bool admin = false;
  for (DWORD i = 0; i < values->GroupCount; ++i) {
    const auto& group = values->Groups[i];
    if (!containedSid(groups, group.Sid)) return false;
    if (IsWellKnownSid(group.Sid, WinBuiltinAdministratorsSid)) {
      if (admin || !(group.Attributes & SE_GROUP_USE_FOR_DENY_ONLY) || (group.Attributes & (SE_GROUP_ENABLED | SE_GROUP_ENABLED_BY_DEFAULT))) return false;
      admin = true;
    }
  }
  return admin; // An absent admin SID is deliberately unsupported in this research proof.
}
bool lowerNewTokenOnly(HANDLE newToken) {
  DWORD rid = 0;
  if (!integrity(newToken, rid)) return false;
  if (rid <= SECURITY_MANDATORY_MEDIUM_RID) return true;
  alignas(DWORD) std::array<std::uint8_t, SECURITY_MAX_SID_SIZE> sid{}; DWORD length = static_cast<DWORD>(sid.size());
  if (!CreateWellKnownSid(WinMediumLabelSid, nullptr, sid.data(), &length)) return false;
  TOKEN_MANDATORY_LABEL label{}; label.Label.Sid = sid.data(); label.Label.Attributes = SE_GROUP_INTEGRITY;
  return SetTokenInformation(newToken, TokenIntegrityLevel, &label, static_cast<DWORD>(sizeof(label)) + length) != FALSE;
}

bool mapping(const std::wstring& drive, std::wstring& output) {
  std::array<wchar_t, 32768> buffer{};
  const DWORD count = QueryDosDeviceW(drive.c_str(), buffer.data(), static_cast<DWORD>(buffer.size()));
  if (!count || count >= buffer.size()) return false;
  const auto end = std::find(buffer.begin(), buffer.begin() + count, L'\0');
  if (end == buffer.begin() || end == buffer.begin() + count) return false;
  output.assign(buffer.begin(), end); return avm::nativeMapping(utf16(output));
}
bool finalPath(HANDLE handle, const std::wstring& expected) {
  std::array<wchar_t, avm::kMaxUtf16 + 128> buffer{};
  const DWORD count = GetFinalPathNameByHandleW(handle, buffer.data(), static_cast<DWORD>(buffer.size()), FILE_NAME_OPENED | VOLUME_NAME_NT);
  if (!count || count >= buffer.size()) return false;
  std::wstring actual(buffer.data(), count), wanted = expected;
  if (actual.size() > 1 && actual.back() == L'\\') actual.pop_back();
  if (wanted.size() > 1 && wanted.back() == L'\\') wanted.pop_back();
  return same(actual, wanted);
}
struct Paths {
  std::wstring directory, drive, device, helperNative, helperDevice;
  std::vector<Handle> guards;
  HANDLE target = nullptr;
  bool targetMissing = false;
};
bool guardPath(Paths& paths, const std::wstring& canonical, bool directory, bool missing, bool binary, HANDLE& final) {
  if (canonical.size() < 3 || canonical.substr(0, 2) != paths.drive) return false;
  std::wstring expected = paths.device + L"\\", native = L"\\\\?\\GLOBALROOT" + expected;
  if (GetDriveTypeW(native.c_str()) != DRIVE_FIXED) return false;
  std::size_t at = 3;
  for (;;) {
    const bool leaf = at > canonical.size();
    DWORD access = FILE_READ_ATTRIBUTES | ((leaf && binary) ? GENERIC_READ : 0);
    DWORD sharing = FILE_SHARE_READ;
    if (leaf && !binary && !directory) {
      const DWORD observed = GetFileAttributesW(native.c_str());
      if (observed != INVALID_FILE_ATTRIBUTES && !(observed & FILE_ATTRIBUTE_DIRECTORY)) sharing |= FILE_SHARE_WRITE;
    }
    // Match the helper's one ordinary-file exception for the runner's held wx+ fixture.
    // This is metadata identity checking, not a content lease. No handle permits DELETE sharing.
    Handle handle(CreateFileW(native.c_str(), access, sharing, nullptr, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    if (!valid(handle)) {
      const DWORD error = GetLastError();
      if (leaf && missing && !binary && (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND)) { final = nullptr; return true; }
      return false;
    }
    BY_HANDLE_FILE_INFORMATION info{};
    if (!GetFileInformationByHandle(handle.get(), &info) || !finalPath(handle.get(), expected) ||
        (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) ||
        ((!leaf || directory) && !(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)) ||
        ((sharing & FILE_SHARE_WRITE) && (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)) ||
        (leaf && binary && ((info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) || info.nNumberOfLinks != 1))) return false;
    final = handle.get(); paths.guards.push_back(std::move(handle));
    if (leaf) return true;
    const auto end = canonical.find(L'\\', at);
    if (native.back() != L'\\') { native += L'\\'; expected += L'\\'; }
    const auto part = canonical.substr(at, end == std::wstring::npos ? end : end - at);
    if (part.empty()) return false;
    native += part; expected += part;
    at = end == std::wstring::npos ? canonical.size() + 1 : end + 1;
  }
}
bool derivePaths(const avm::Request& request, Paths& paths) {
  std::array<wchar_t, avm::kMaxUtf16 + 1> module{};
  const DWORD count = GetModuleFileNameW(nullptr, module.data(), static_cast<DWORD>(module.size()));
  if (!count || count >= module.size()) return false;
  std::u16string canonical = utf16(std::wstring(module.data(), count));
  if (!avm::canonicalize(canonical)) return false;
  const std::wstring self = wide(canonical);
  const auto slash = self.find_last_of(L'\\');
  if (slash == std::wstring::npos || slash <= 3) return false;
  paths.directory = self.substr(0, slash); paths.drive = self.substr(0, 2);
  // A research build directory is mandatory, not a profile/public root.
  const std::wstring x64 = L"\\build\\windows-x64", arm64 = L"\\build\\windows-arm64";
  if (!((paths.directory.size() >= x64.size() && same(paths.directory.substr(paths.directory.size() - x64.size()), x64)) ||
        (paths.directory.size() >= arm64.size() && same(paths.directory.substr(paths.directory.size() - arm64.size()), arm64)))) return false;
  const std::wstring target = wide(request.path), prefix = paths.directory + L"\\";
  if (target.size() <= prefix.size() || !same(target.substr(0, prefix.size()), prefix)) return false;
  const auto split = target.find(L'\\', prefix.size());
  if (split == std::wstring::npos || split + 1 >= target.size()) return false;
  const std::wstring component = target.substr(prefix.size(), split - prefix.size()), name = L"metadata-smoke-";
  if (component.compare(0, name.size(), name) || component.size() < name.size() + 6 || component.size() > name.size() + 32) return false;
  for (std::size_t i = name.size(); i < component.size(); ++i) {
    const wchar_t c = component[i];
    if (!((c >= L'a' && c <= L'z') || (c >= L'A' && c <= L'Z') || (c >= L'0' && c <= L'9') || c == L'_' || c == L'-')) return false;
  }
  if (!mapping(paths.drive, paths.device)) return false;
  paths.helperDevice = paths.device + paths.directory.substr(2) + L"\\agentvac-metadata-research.exe";
  paths.helperNative = L"\\\\?\\GLOBALROOT" + paths.helperDevice;
  return true;
}
bool boundHash(HANDLE file) {
  std::array<std::uint8_t, 32> expected{};
  auto digit = [](char c) { return c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : -1; };
  for (std::size_t i = 0; i < expected.size(); ++i) {
    const int a = digit(kHelperHash[2 * i]), b = digit(kHelperHash[2 * i + 1]);
    if (a < 0 || b < 0) return false;
    expected[i] = static_cast<std::uint8_t>((a << 4) | b);
  }
  LARGE_INTEGER size{};
  if (!GetFileSizeEx(file, &size) || size.QuadPart <= 0 || size.QuadPart > kMaxBinary) return false;
  BCRYPT_ALG_HANDLE algorithm = nullptr; BCRYPT_HASH_HANDLE hash = nullptr;
  std::vector<std::uint8_t> object; // The object backing memory must outlive BCryptDestroyHash.
  struct Cleanup {
    BCRYPT_ALG_HANDLE& algorithm; BCRYPT_HASH_HANDLE& hash;
    ~Cleanup() { if (hash) BCryptDestroyHash(hash); if (algorithm) BCryptCloseAlgorithmProvider(algorithm, 0); }
  } cleanup{algorithm, hash};
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, MS_PRIMITIVE_PROVIDER, 0) < 0) return false;
  DWORD objectSize = 0, hashSize = 0, returned = 0;
  if (BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&objectSize), sizeof(objectSize), &returned, 0) < 0 ||
      returned != sizeof(objectSize) || !objectSize || objectSize > 65536 ||
      BCryptGetProperty(algorithm, BCRYPT_HASH_LENGTH, reinterpret_cast<PUCHAR>(&hashSize), sizeof(hashSize), &returned, 0) < 0 ||
      returned != sizeof(hashSize) || hashSize != expected.size()) return false;
  object.resize(objectSize);
  if (BCryptCreateHash(algorithm, &hash, object.data(), objectSize, nullptr, 0, 0) < 0) return false;
  std::array<std::uint8_t, 32768> buffer{}; LONGLONG remaining = size.QuadPart;
  while (remaining) {
    if (stopped()) return false;
    DWORD got = 0;
    const DWORD wanted = static_cast<DWORD>(std::min<LONGLONG>(remaining, static_cast<LONGLONG>(buffer.size())));
    if (!ReadFile(file, buffer.data(), wanted, &got, nullptr) || !got || BCryptHashData(hash, buffer.data(), got, 0) < 0) return false;
    remaining -= got;
  }
  std::uint8_t extra = 0; DWORD got = 0;
  if (!ReadFile(file, &extra, 1, &got, nullptr) || got) return false;
  std::array<std::uint8_t, 32> actual{};
  return BCryptFinishHash(hash, actual.data(), static_cast<ULONG>(actual.size()), 0) >= 0 && actual == expected;
}

bool objectName(HANDLE object, std::wstring& name) {
  std::array<wchar_t, 256> bytes{}; DWORD count = 0;
  if (!GetUserObjectInformationW(object, UOI_NAME, bytes.data(), static_cast<DWORD>(sizeof(bytes)), &count) ||
      count < 2 * sizeof(wchar_t) || count > sizeof(bytes) || count % sizeof(wchar_t)) return false;
  const std::size_t chars = count / sizeof(wchar_t);
  if (bytes[chars - 1] != L'\0') return false;
  name.assign(bytes.data(), chars - 1);
  return !name.empty() && std::all_of(name.begin(), name.end(), [](wchar_t c) { return c > 0x20 && c < 0x7f && c != L'\\' && c != L'/'; });
}
bool noninteractiveDesktop(std::wstring& name) {
  HWINSTA station = GetProcessWindowStation(); HDESK desktop = GetThreadDesktop(GetCurrentThreadId());
  USEROBJECTFLAGS flags{}; DWORD count = 0; std::wstring stationName, desktopName;
  if (!station || !desktop || !GetUserObjectInformationW(station, UOI_FLAGS, &flags, sizeof(flags), &count) ||
      count != sizeof(flags) || (flags.dwFlags & WSF_VISIBLE) ||
      !objectName(station, stationName) || !objectName(desktop, desktopName) || same(stationName, L"WinSta0")) return false;
  name = stationName + L"\\" + desktopName; return true;
}
struct Attributes {
  std::vector<std::uint8_t> storage; LPPROC_THREAD_ATTRIBUTE_LIST list = nullptr;
  ~Attributes() { if (list) DeleteProcThreadAttributeList(list); }
  bool init() {
    SIZE_T size = 0;
    if (InitializeProcThreadAttributeList(nullptr, 3, 0, &size) || GetLastError() != ERROR_INSUFFICIENT_BUFFER || !size || size > 65536) return false;
    storage.resize(size); auto* value = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
    if (!InitializeProcThreadAttributeList(value, 3, 0, &size)) return false;
    list = value; return true;
  }
};
struct Child {
  Handle job, process, thread;
  ~Child() {
    if (process && WaitForSingleObject(process.get(), 0) != WAIT_OBJECT_0) {
      if (job) TerminateJobObject(job.get(), 125);
      WaitForSingleObject(process.get(), 500);
    }
    // The sole job handle is noninheritable; closing it kills any remaining member.
  }
};
bool makePipe(Handle& reader, Handle& writer, bool inheritReader) {
  SECURITY_ATTRIBUTES security{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE}; HANDLE r = nullptr, w = nullptr;
  if (!CreatePipe(&r, &w, &security, 32768)) return false;
  reader.reset(r); writer.reset(w);
  return SetHandleInformation(inheritReader ? writer.get() : reader.get(), HANDLE_FLAG_INHERIT, 0) != FALSE;
}
bool validateResponse(const Report& report, const avm::Request& request, const Paths& paths) {
  const auto* f = report.frame.data(); const auto* b = f + 4;
  if (avm::u32(f) != avm::kResponseSize || std::memcmp(b, "AVM1", 4) || b[4] > 7 || b[6] || b[7] || (b[5] != 0 && b[5] != 5 && b[5] != 7)) return false;
  const bool zeroMetadata = std::all_of(b + 8, b + avm::kResponseSize, [](std::uint8_t c) { return c == 0; });
  if (b[4] > 1) return b[5] == 0 && zeroMetadata;
  if ((b[4] == 1) != request.acl) return false;
  if (!b[5]) return paths.targetMissing && request.missing && !request.acl && zeroMetadata;
  if (paths.targetMissing || !paths.target) return false;
  BY_HANDLE_FILE_INFORMATION info{}; FILE_ID_INFO id{};
  if (!GetFileInformationByHandle(paths.target, &info) || !GetFileInformationByHandleEx(paths.target, FileIdInfo, &id, sizeof(id))) return false;
  std::array<std::uint8_t, avm::kResponseSize> expected{};
  std::memcpy(expected.data(), "AVM1", 4); expected[4] = b[4];
  const bool directory = (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
  if ((request.directory && !directory) || (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) || !info.nNumberOfLinks) return false;
  expected[5] = static_cast<std::uint8_t>(1 | 4 | (directory ? 2 : 0));
  avm::put64(expected.data() + 8, info.dwVolumeSerialNumber);
  avm::put64(expected.data() + 16, (static_cast<std::uint64_t>(info.nFileIndexHigh) << 32) | info.nFileIndexLow);
  avm::put64(expected.data() + 24, (static_cast<std::uint64_t>(info.nFileSizeHigh) << 32) | info.nFileSizeLow);
  avm::put32(expected.data() + 32, info.nNumberOfLinks); avm::put32(expected.data() + 36, info.dwFileAttributes);
  avm::put64(expected.data() + 40, id.VolumeSerialNumber); std::memcpy(expected.data() + 48, id.FileId.Identifier, 16);
  return std::memcmp(expected.data(), b, expected.size()) == 0;
}

Reason run(Report& report) {
  const HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  std::array<std::uint8_t, 4> header{};
  if (!readExact(input, header.data(), static_cast<DWORD>(header.size()))) return Reason::Request;
  const DWORD size = avm::u32(header.data());
  if (size < 11 || size > avm::kMaxRequest) return Reason::Request;
  std::vector<std::uint8_t> body(size); avm::Request request; std::u16string original;
  if (!readExact(input, body.data(), size) || !ended(input) || !avm::parse(body, request) ||
      !avm::utf8(body, 8, original) || original != request.path) return Reason::Request;
  Paths paths;
  if (!derivePaths(request, paths)) return Reason::Fixture;
  HANDLE helper = nullptr;
  if (!guardPath(paths, paths.directory + L"\\agentvac-metadata-research.exe", false, false, true, helper) || !boundHash(helper)) return Reason::Binding;
  report.evidence |= BoundHelper;
  if (!guardPath(paths, wide(request.path), request.directory, request.missing, false, paths.target)) return Reason::Fixture;
  paths.targetMissing = paths.target == nullptr;

  std::array<wchar_t, 260> windows{};
  const UINT windowsLength = GetWindowsDirectoryW(windows.data(), static_cast<UINT>(windows.size()));
  if (!windowsLength || windowsLength >= windows.size() || !same(std::wstring(windows.data(), windowsLength), L"C:\\Windows")) return Reason::Launch;
  HANDLE raw = nullptr;
  // The caller checks below must describe the actual effective caller. No impersonation fallback.
  if (OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, TRUE, &raw)) { Handle impersonation(raw); return Reason::Token; }
  if (GetLastError() != ERROR_NO_TOKEN) return Reason::Token;
  raw = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT, &raw)) return Reason::Token;
  Handle caller(raw); std::vector<std::uint8_t> callerUser; DWORD session = 0, processSession = 0;
  if (!tokenBytes(caller.get(), TokenUser, callerUser) || !userSid(callerUser) ||
      !tokenValue(caller.get(), TokenSessionId, session) || !ProcessIdToSessionId(GetCurrentProcessId(), &processSession) || session != processSession) return Reason::Token;
  alignas(DWORD) std::array<std::uint8_t, SECURITY_MAX_SID_SIZE> admins{}; DWORD adminSize = static_cast<DWORD>(admins.size());
  if (!CreateWellKnownSid(WinBuiltinAdministratorsSid, nullptr, admins.data(), &adminSize)) return Reason::Token;
  SID_AND_ATTRIBUTES disable{admins.data(), 0}; raw = nullptr;
  if (!CreateRestrictedToken(caller.get(), DISABLE_MAX_PRIVILEGE | LUA_TOKEN, 1, &disable, 0, nullptr, 0, nullptr, &raw)) return Reason::Token;
  Handle candidate(raw); DWORD candidateRid = 0;
  if (!lowerNewTokenOnly(candidate.get()) || !verifyToken(candidate.get(), userSid(callerUser), session, candidateRid)) return Reason::Token;
  report.candidateIntegrity = candidateRid; report.evidence |= CandidateVerified;
  if (!privileges(caller.get(), false)) return Reason::Token;
  std::wstring desktop;
  if (!noninteractiveDesktop(desktop)) return Reason::Desktop;

  Child child; child.job.reset(CreateJobObjectW(nullptr, nullptr));
  if (!child.job) return Reason::Job;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
  limits.BasicLimitInformation.ActiveProcessLimit = 1;
  JOBOBJECT_BASIC_UI_RESTRICTIONS ui{};
  ui.UIRestrictionsClass = JOB_OBJECT_UILIMIT_HANDLES | JOB_OBJECT_UILIMIT_READCLIPBOARD | JOB_OBJECT_UILIMIT_WRITECLIPBOARD |
    JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS | JOB_OBJECT_UILIMIT_DISPLAYSETTINGS | JOB_OBJECT_UILIMIT_GLOBALATOMS |
    JOB_OBJECT_UILIMIT_DESKTOP | JOB_OBJECT_UILIMIT_EXITWINDOWS;
  if (!SetInformationJobObject(child.job.get(), JobObjectExtendedLimitInformation, &limits, sizeof(limits)) ||
      !SetInformationJobObject(child.job.get(), JobObjectBasicUIRestrictions, &ui, sizeof(ui))) return Reason::Job;
  Handle childIn, parentWrite, parentRead, childOut;
  if (!makePipe(childIn, parentWrite, true) || !makePipe(parentRead, childOut, false)) return Reason::Pipe;
  // Attribute backing values outlive the list, as required by UpdateProcThreadAttribute.
  HANDLE inherited[] = {childIn.get(), childOut.get()}, jobs[] = {child.job.get()};
  DWORD64 mitigation = PROCESS_CREATION_MITIGATION_POLICY_WIN32K_SYSTEM_CALL_DISABLE_ALWAYS_ON;
  Attributes attributes;
  if (!attributes.init()) return Reason::Job;
  if (!UpdateProcThreadAttribute(attributes.list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited, sizeof(inherited), nullptr, nullptr) ||
      !UpdateProcThreadAttribute(attributes.list, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, jobs, sizeof(jobs), nullptr, nullptr) ||
      !UpdateProcThreadAttribute(attributes.list, 0, PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY, &mitigation, sizeof(mitigation), nullptr, nullptr)) return Reason::Job;
  STARTUPINFOEXW startup{}; startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW; startup.StartupInfo.wShowWindow = SW_HIDE;
  startup.StartupInfo.hStdInput = childIn.get(); startup.StartupInfo.hStdOutput = childOut.get(); startup.StartupInfo.hStdError = childOut.get();
  startup.StartupInfo.lpDesktop = desktop.data(); startup.lpAttributeList = attributes.list;
  wchar_t environment[] = L"SystemRoot=C:\\Windows\0";
  std::wstring command = L"\"" + paths.helperNative + L"\"";
  const std::wstring currentDirectory = L"\\\\?\\GLOBALROOT" + paths.device + paths.directory.substr(2);
  std::wstring mappingNow;
  if (!mapping(paths.drive, mappingNow) || mappingNow != paths.device || stopped()) return Reason::Fixture;
  PROCESS_INFORMATION process{};
  // Inherit the launcher's error-box suppression rather than restoring the default error mode.
  const DWORD flags = CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT;
  if (!CreateProcessAsUserW(candidate.get(), paths.helperNative.c_str(), command.data(), nullptr, nullptr, TRUE, flags,
      environment, currentDirectory.c_str(), &startup.StartupInfo, &process)) return Reason::Launch;
  child.process.reset(process.hProcess); child.thread.reset(process.hThread);
  childIn.reset(); childOut.reset(); // Only the child's designated pipe ends are inherited.
  BOOL inJob = FALSE;
  if (!IsProcessInJob(child.process.get(), child.job.get(), &inJob) || !inJob) return Reason::Job;
  report.evidence |= JobContained;
  PROCESS_MITIGATION_SYSTEM_CALL_DISABLE_POLICY systemCalls{};
  if (!GetProcessMitigationPolicy(child.process.get(), ProcessSystemCallDisablePolicy, &systemCalls, sizeof(systemCalls)) ||
      !systemCalls.DisallowWin32kSystemCalls) return Reason::Desktop;
  raw = nullptr;
  if (!OpenProcessToken(child.process.get(), TOKEN_QUERY, &raw)) return Reason::ChildToken;
  Handle actual(raw); DWORD actualRid = 0;
  if (!verifyToken(actual.get(), userSid(callerUser), session, actualRid) || actualRid != candidateRid) return Reason::ChildToken;
  std::array<wchar_t, avm::kMaxUtf16 + 128> image{}; DWORD imageSize = static_cast<DWORD>(image.size());
  if (!QueryFullProcessImageNameW(child.process.get(), PROCESS_NAME_NATIVE, image.data(), &imageSize) || !imageSize ||
      imageSize >= image.size() || !same(std::wstring(image.data(), imageSize), paths.helperDevice)) return Reason::Binding;
  report.childIntegrity = actualRid; report.evidence |= ChildVerified;
  if (!mapping(paths.drive, mappingNow) || mappingNow != paths.device) return Reason::Fixture;
  if (stopped()) return Reason::Deadline;
  if (ResumeThread(child.thread.get()) != 1) return Reason::Launch;
  if (!writeExact(parentWrite.get(), header.data(), static_cast<DWORD>(header.size())) || !writeExact(parentWrite.get(), body.data(), size)) return Reason::Pipe;
  parentWrite.reset(); // EOF terminates exactly one request; no interactive stdin.
  if (!readExact(parentRead.get(), report.frame.data(), static_cast<DWORD>(report.frame.size())) || !ended(parentRead.get())) return Reason::Response;
  for (;;) {
    const DWORD wait = WaitForSingleObject(child.process.get(), 5);
    if (wait == WAIT_OBJECT_0) break;
    if (wait != WAIT_TIMEOUT || stopped()) return Reason::Deadline;
  }
  DWORD exitCode = 0;
  if (!GetExitCodeProcess(child.process.get(), &exitCode) || exitCode) return Reason::Response;
  report.evidence |= ExitedClean;
  if (!mapping(paths.drive, mappingNow) || mappingNow != paths.device) return Reason::Fixture;
  if (!validateResponse(report, request, paths)) return Reason::Response;
  report.evidence |= ResponseValidated;
  return Reason::None;
}
bool emit(Reason reason, const Report& report) {
  std::array<std::uint8_t, kPrefixBytes + kHelperFrameBytes> bytes{};
  std::memcpy(bytes.data(), "AVR1", 4); bytes[4] = reason == Reason::None ? 0 : 1; bytes[5] = static_cast<std::uint8_t>(reason);
  avm::put32(bytes.data() + 8, report.candidateIntegrity); avm::put32(bytes.data() + 12, report.childIntegrity);
  avm::put32(bytes.data() + 16, report.evidence);
  std::size_t count = kPrefixBytes;
  if (reason == Reason::None) {
    avm::put32(bytes.data() + 24, static_cast<std::uint32_t>(report.frame.size()));
    std::memcpy(bytes.data() + kPrefixBytes, report.frame.data(), report.frame.size()); count += report.frame.size();
  }
  // A deadline report gets a short chance to emit before the independent hard stop.
  DWORD written = 0;
  return WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), bytes.data(), static_cast<DWORD>(count), &written, nullptr) && written == count;
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
  Report report; Reason reason = Reason::Request;
  const bool pipes = GetFileType(GetStdHandle(STD_INPUT_HANDLE)) == FILE_TYPE_PIPE && GetFileType(GetStdHandle(STD_OUTPUT_HANDLE)) == FILE_TYPE_PIPE;
  const BOOL controls = SetConsoleCtrlHandler(control, TRUE);
  if (argc == 1 && pipes) {
    try { reason = run(report); } catch (...) { reason = Reason::Response; }
  }
  if (stopped()) reason = Reason::Deadline;
  const bool sent = pipes && emit(reason, report);
  if (controls) SetConsoleCtrlHandler(control, FALSE);
  gCancel = nullptr;
  SetEvent(done.get()); WaitForSingleObject(watcher.get(), INFINITE);
  return sent && reason == Reason::None ? 0 : 125;
}
