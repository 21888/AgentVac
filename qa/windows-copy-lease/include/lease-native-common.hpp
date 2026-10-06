// Derived from independently reviewed source9aa; detached lease changes require new review.
#pragma once
#ifndef _WIN32
#error This translation unit requires the Windows SDK; Linux tests cover core.hpp only.
#endif
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <aclapi.h>
#include <array>
#include <cstring>
#include <cstddef>
#include <memory>
#include "core.hpp"
#include "lease-core.hpp"
#include "inherited-request.hpp"
#include "inherited-context.hpp"

#ifndef AVM_GENERATED_EXECUTABLE_NAME
#define AVM_GENERATED_EXECUTABLE_NAME L"agentvac-copy-lease-research.exe"
#endif
namespace {
using avm::Code;
constexpr Code kContextRejected = static_cast<Code>(8), kCallerRejected = static_cast<Code>(9), kScopeRejected = static_cast<Code>(10);
struct Close { void operator()(void* h) const { if (h && h != INVALID_HANDLE_VALUE) CloseHandle(h); } };
using Handle = std::unique_ptr<void, Close>;
struct Free { void operator()(void* p) const { if (p) LocalFree(p); } };
using Local = std::unique_ptr<void, Free>;
std::wstring wide(const std::u16string& s) { static_assert(sizeof(wchar_t) == sizeof(char16_t)); return std::wstring(s.begin(), s.end()); }
std::u16string narrow(const std::wstring& s) { return std::u16string(s.begin(), s.end()); }

bool readExact(HANDLE h, void* p, DWORD length) {
  auto* bytes = static_cast<std::uint8_t*>(p);
  while (length) { DWORD count = 0; if (!ReadFile(h, bytes, length, &count, nullptr) || !count) return false; bytes += count; length -= count; }
  return true;
}
bool writeExact(HANDLE h, const void* p, DWORD length) {
  const auto* bytes = static_cast<const std::uint8_t*>(p);
  while (length) { DWORD count = 0; if (!WriteFile(h, bytes, length, &count, nullptr) || !count) return false; bytes += count; length -= count; }
  return true;
}
DWORD WINAPI deadline(void*) { Sleep(avm_lease::kLeaseMs); TerminateProcess(GetCurrentProcess(), 124); return 0; }

bool directMapping(const std::wstring& drive, std::wstring& mapping) {
  std::array<wchar_t,32768> buffer{};
  const DWORD count = QueryDosDeviceW(drive.c_str(), buffer.data(), static_cast<DWORD>(buffer.size()));
  if (!count || count >= buffer.size()) return false;
  const auto end = std::find(buffer.begin(), buffer.begin() + count, L'\0');
  if (end == buffer.begin() || end == buffer.begin() + count) return false;
  mapping.assign(buffer.begin(), end); // The first string is current. Ignore historical targets.
  return avm::nativeMapping(narrow(mapping));
}
bool sameNativePath(HANDLE handle, const std::wstring& expected) {
  std::array<wchar_t, avm::kMaxUtf16 + 128> buffer{};
  const DWORD count = GetFinalPathNameByHandleW(handle, buffer.data(), static_cast<DWORD>(buffer.size()), FILE_NAME_OPENED | VOLUME_NAME_NT);
  if (!count || count >= buffer.size()) return false;
  std::wstring actual(buffer.data(), count), target = expected;
  // Windows may omit the volume root's final slash in its handle name.
  if (actual.size() > 1 && actual.back() == L'\\') actual.pop_back();
  if (target.size() > 1 && target.back() == L'\\') target.pop_back();
  return CompareStringOrdinal(actual.c_str(), static_cast<int>(actual.size()), target.c_str(), static_cast<int>(target.size()), TRUE) == CSTR_EQUAL;
}
struct Observation {
  Code code = Code::MetadataUnavailable;
  bool exists = false, directory = false;
  avm_lease::Reason reason=avm_lease::Reason::None;
  BY_HANDLE_FILE_INFORMATION legacy{};
  FILE_ID_INFO identity{};
};

avm::Principal principal(PSID sid, PSID current) {
  if (!sid || !IsValidSid(sid) || !avm::sidShape(static_cast<SID*>(sid)->Revision, static_cast<SID*>(sid)->SubAuthorityCount)) return avm::Principal::Invalid;
  if (EqualSid(sid, current)) return avm::Principal::Current;
  if (IsWellKnownSid(sid, WinLocalSystemSid)) return avm::Principal::System;
  if (IsWellKnownSid(sid, WinBuiltinAdministratorsSid)) return avm::Principal::Administrators;
  return avm::Principal::Other;
}
bool generatedScope(const avm_inherited::Request& request) {
  std::array<wchar_t,avm::kMaxUtf16+1> buffer{};
  const DWORD count = GetModuleFileNameW(nullptr,buffer.data(),static_cast<DWORD>(buffer.size()));
  if (!count || count >= buffer.size()) return false;
  auto module = narrow(std::wstring(buffer.data(),count));
  if (!avm::canonicalize(module)) return false;
  const std::wstring own = wide(module), scope = wide(request.scope), target = wide(request.target.path);
  const auto slash = own.find_last_of(L'\\');
  if (slash == std::wstring::npos) return false;
  const std::wstring directory = own.substr(0,slash), filename = own.substr(slash+1);
  const auto equal = [](const std::wstring& a,const std::wstring& b) { return a.size()==b.size() && CompareStringOrdinal(a.c_str(),static_cast<int>(a.size()),b.c_str(),static_cast<int>(b.size()),TRUE)==CSTR_EQUAL; };
  if (!equal(filename,AVM_GENERATED_EXECUTABLE_NAME)) return false;
  const std::wstring x64=L"\\build\\windows-x64", arm64=L"\\build\\windows-arm64";
  if (!((directory.size()>=x64.size() && equal(directory.substr(directory.size()-x64.size()),x64)) || (directory.size()>=arm64.size() && equal(directory.substr(directory.size()-arm64.size()),arm64)))) return false;
  const std::wstring prefix=directory+L"\\inherited-fixture-";
  if (scope.size()!=prefix.size()+32 || !equal(scope.substr(0,prefix.size()),prefix)) return false;
  for (std::size_t i=prefix.size();i<scope.size();++i) if (!((scope[i]>=L'0'&&scope[i]<=L'9')||(scope[i]>=L'a'&&scope[i]<=L'f'))) return false;
  if (equal(target,scope)) return true;
  return target.size()>scope.size()+1 && target[scope.size()]==L'\\' && equal(target.substr(0,scope.size()),scope);
}
Code inspectAcl(HANDLE target, bool inheritance, PSID current) {
  PSID owner = nullptr; PACL dacl = nullptr; PSECURITY_DESCRIPTOR raw = nullptr;
  const DWORD error = GetSecurityInfo(target, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &owner, nullptr, &dacl, nullptr, &raw);
  Local descriptor(raw);
  if (error != ERROR_SUCCESS || !raw || !IsValidSecurityDescriptor(raw)) return Code::MetadataUnavailable;
  if (!dacl || !IsValidAcl(dacl) || dacl->AceCount == 0 || dacl->AceCount > 128) return Code::AclRejected;
  ACL_SIZE_INFORMATION size{};
  if (!GetAclInformation(dacl, &size, sizeof(size), AclSizeInformation) || size.AceCount != dacl->AceCount || size.AclBytesInUse > dacl->AclSize) return Code::MetadataUnavailable;
  std::vector<avm::Ace> entries; entries.reserve(dacl->AceCount);
  for (DWORD i=0; i<dacl->AceCount; ++i) {
    void* rawAce = nullptr; if (!GetAce(dacl, i, &rawAce)) return Code::MetadataUnavailable;
    const auto* header = static_cast<const ACE_HEADER*>(rawAce);
    // No callbacks, object-specific qualifiers, compound ACEs or unknown flags.
    // Never skip an unrecognized entry or normalize generic rights into approval.
    if ((header->AceType != ACCESS_ALLOWED_ACE_TYPE && header->AceType != ACCESS_DENIED_ACE_TYPE) || (header->AceFlags & ~0x1f) != 0 || header->AceSize < offsetof(ACCESS_ALLOWED_ACE, SidStart) + 8) return Code::AclRejected;
    auto* ace = static_cast<ACCESS_ALLOWED_ACE*>(rawAce);
    PSID sid = &ace->SidStart;
    const auto* sidHeader = static_cast<SID*>(sid);
    const DWORD sidLength = 8u + 4u * sidHeader->SubAuthorityCount;
    if (!avm::sidShape(sidHeader->Revision,sidHeader->SubAuthorityCount) || sidLength + offsetof(ACCESS_ALLOWED_ACE, SidStart) != header->AceSize || !IsValidSid(sid)) return Code::AclRejected;
    const BYTE flags = header->AceFlags;
    // .NET InheritanceFlags: ContainerInherit=1, ObjectInherit=2. Win32 bits are reversed.
    const int inherit = ((flags & CONTAINER_INHERIT_ACE) ? 1 : 0) | ((flags & OBJECT_INHERIT_ACE) ? 2 : 0);
    const int propagate = ((flags & NO_PROPAGATE_INHERIT_ACE) ? 1 : 0) | ((flags & INHERIT_ONLY_ACE) ? 2 : 0);
    entries.push_back({principal(sid,current), static_cast<std::int64_t>(ace->Mask), header->AceType == ACCESS_ALLOWED_ACE_TYPE ? avm::Kind::Allow : avm::Kind::Deny, (flags & INHERITED_ACE) != 0, inherit, propagate});
  }
  return avm::privateAcl(principal(owner,current), avm::canonicalAcl(entries), entries, inheritance) ? Code::Private : Code::AclRejected;
}

struct HeldPath { Handle handle; std::wstring expected; BY_HANDLE_FILE_INFORMATION initial{}; bool privateAcl=false; bool directory=false; };
struct HeldLease { std::vector<HeldPath> paths; std::wstring drive, mapping; };
Observation inspectLease(const avm_inherited::Request& whole, PSID currentUserSid, HeldLease& retained) {
  const auto& request=whole.target;

  Observation result;
  const std::wstring canonical = wide(request.path), drive = canonical.substr(0,2);
  std::wstring mapping;
  if (!directMapping(drive, mapping)) { result.code = Code::LocalityRejected; return result; }
  // All later I/O uses this exact direct native device, never the mutable DOS alias.
  // GLOBALROOT is an internal derived spelling; it is never accepted from input.
  const std::wstring nativeRoot = L"\\\\?\\GLOBALROOT" + mapping + L"\\";
  if (GetDriveTypeW(nativeRoot.c_str()) != DRIVE_FIXED) { result.code = Code::LocalityRejected; return result; }
  std::wstring native = nativeRoot, expected = mapping + L"\\";
  retained.paths.reserve(avm::kMaxComponents + 1);
  const std::size_t privateIndex=1+static_cast<std::size_t>(std::count(whole.scope.begin()+3,whole.scope.end(),u'\\'));
  retained.drive=drive;retained.mapping=mapping;
  std::vector<std::wstring> components;
  for (std::size_t at=3; at<canonical.size();) {
    const auto end = canonical.find(L'\\',at); components.push_back(canonical.substr(at,end == std::wstring::npos ? end : end-at));
    if (end == std::wstring::npos) break;
    at = end+1;
  }
  for (std::size_t index=0; index<=components.size(); ++index) {
    const bool final = index == components.size();
    if (index) { if (native.back() != L'\\') { native += L'\\'; expected += L'\\'; } native += components[index-1]; expected += components[index-1]; }
    // Only inspect this component, after every preceding component is held and checked.
    const DWORD attrs = GetFileAttributesW(native.c_str());
    if (attrs == INVALID_FILE_ATTRIBUTES) {
      const DWORD error = GetLastError();
      if (request.missing && final && index && (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND)) {
        std::wstring mappingAfter;
        result.code = directMapping(drive,mappingAfter) && mappingAfter == mapping ? Code::Local : Code::LocalityRejected;
        return result;
      }
      result.code = Code::LocalityRejected; return result;
    }
    if ((attrs & FILE_ATTRIBUTE_REPARSE_POINT) || ((!final || request.directory) && !(attrs & FILE_ATTRIBUTE_DIRECTORY))) { result.code = Code::LocalityRejected; return result; }
    // Metadata-only access does not participate in read/write/delete sharing.
    // Retain directory traversal rights or regular-file read rights explicitly;
    // never enumerate a directory or read target contents through these handles.
    // No weaker-rights retry is permitted if this open is denied.
    static_assert(FILE_READ_ATTRIBUTES==0x80u && READ_CONTROL==0x20000u &&
      FILE_READ_DATA==0x1u && FILE_TRAVERSE==0x20u && FILE_EXECUTE==FILE_TRAVERSE &&
      FILE_SHARE_READ==0x1u && FILE_SHARE_WRITE==0x2u && FILE_SHARE_DELETE==0x4u,
      "reviewed Windows share-participating rights");
    const bool privateBoundary=index>=privateIndex;
    const auto policy=avm_lease::retainedOpenPolicy((attrs & FILE_ATTRIBUTE_DIRECTORY)!=0, privateBoundary || (final && request.acl));
    const DWORD share=policy.shareAccess, access=policy.desiredAccess;
    Handle handle(CreateFileW(native.c_str(), access, share, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    if (handle.get() == INVALID_HANDLE_VALUE) { result.code = Code::MetadataUnavailable; if(GetLastError()==ERROR_SHARING_VIOLATION) result.reason=avm_lease::Reason::SharingConflict; return result; }
    BY_HANDLE_FILE_INFORMATION info{};
    if (!GetFileInformationByHandle(handle.get(), &info) || !sameNativePath(handle.get(),expected)) { result.code = Code::MetadataUnavailable; return result; }
    if (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT || ((!final || request.directory) && !(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY))) { result.code = Code::LocalityRejected; return result; }
    // Node's held-descriptor parity uses the documented legacy volume/file-ID
    // pair. That 64-bit file ID is not guaranteed unique on ReFS; first profile
    // supports NTFS only, established on the held volume-root handle.
    if(index==0){std::array<wchar_t,32> filesystem{};DWORD serial=0,maximum=0,flags=0;
      if(!GetVolumeInformationByHandleW(handle.get(),nullptr,0,&serial,&maximum,&flags,filesystem.data(),static_cast<DWORD>(filesystem.size()))){result.code=Code::MetadataUnavailable;return result;}
      if(serial!=info.dwVolumeSerialNumber){result.code=Code::IdentityUnavailable;return result;}
      if(!(flags&FILE_PERSISTENT_ACLS)||CompareStringOrdinal(filesystem.data(),-1,L"NTFS",-1,TRUE)!=CSTR_EQUAL){result.code=Code::LocalityRejected;result.reason=avm_lease::Reason::UnsupportedFilesystem;return result;}}
    else if(retained.paths.empty() || info.dwVolumeSerialNumber!=retained.paths.front().initial.dwVolumeSerialNumber){result.code=Code::LocalityRejected;return result;}
    if(privateBoundary && !final) {const Code acl=inspectAcl(handle.get(),true,currentUserSid);if(acl!=Code::Private){result.code=acl;return result;}}
    if (final) {
      result.code = request.acl ? inspectAcl(handle.get(), request.directory, currentUserSid) : Code::Local;
      if (result.code != Code::Local && result.code != Code::Private) return result;
      BY_HANDLE_FILE_INFORMATION after{};
      if (!GetFileInformationByHandle(handle.get(), &after) || !GetFileInformationByHandleEx(handle.get(), FileIdInfo, &result.identity, sizeof(result.identity))) { result.code = Code::IdentityUnavailable; return result; }
      if (after.dwVolumeSerialNumber != info.dwVolumeSerialNumber || after.nFileIndexHigh != info.nFileIndexHigh || after.nFileIndexLow != info.nFileIndexLow || after.dwFileAttributes != info.dwFileAttributes || after.nFileSizeHigh != info.nFileSizeHigh || after.nFileSizeLow != info.nFileSizeLow || after.nNumberOfLinks != info.nNumberOfLinks || !sameNativePath(handle.get(),expected)) { result.code = Code::IdentityUnavailable; return result; }
      result.exists = true; result.directory = (after.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0; result.legacy = after;
      const auto size=(static_cast<std::uint64_t>(after.nFileSizeHigh)<<32)|after.nFileSizeLow;
      if(!avm_lease::initialFile(result.directory,size,after.nNumberOfLinks)) {const auto reason=result.directory?avm_lease::Reason::NotRegular:after.nNumberOfLinks!=1?avm_lease::Reason::Hardlink:avm_lease::Reason::Nonempty;result={};result.code=Code::IdentityUnavailable;result.reason=reason;return result;}
      std::wstring mappingAfter;
      if (!directMapping(drive,mappingAfter) || mappingAfter != mapping) { result = {}; result.code = Code::LocalityRejected; }
      if(result.code==Code::Private)retained.paths.push_back({std::move(handle),expected,after,true,false});
      return result;
    }
    retained.paths.push_back({std::move(handle),expected,info,privateBoundary,true});
  }
  return result;
}

bool contextStable(const avm_inherited::BoundCaller& caller,const TOKEN_STATISTICS& own,const TOKEN_STATISTICS& peer) {
 return avm_inherited::detail::threadState()==avm_inherited::ThreadState::Absent &&
   avm_inherited::detail::alive(caller.process.get())==avm_inherited::Outcome::Verified &&
   avm_inherited::detail::stillSamePrimary(GetCurrentProcess(),own) &&
   avm_inherited::detail::stillSamePrimary(caller.process.get(),peer);
}
Observation revalidate(const HeldLease& lease,PSID user) {
 Observation out;if(lease.paths.empty())return out;
 std::wstring mapping;if(!directMapping(lease.drive,mapping)||mapping!=lease.mapping){out.code=Code::LocalityRejected;return out;}
 for(std::size_t i=0;i<lease.paths.size();++i){
  const auto& held=lease.paths[i];BY_HANDLE_FILE_INFORMATION now{};
  if(!GetFileInformationByHandle(held.handle.get(),&now)||!sameNativePath(held.handle.get(),held.expected))return out;
  if(now.dwVolumeSerialNumber!=held.initial.dwVolumeSerialNumber||now.nFileIndexHigh!=held.initial.nFileIndexHigh||now.nFileIndexLow!=held.initial.nFileIndexLow||now.dwFileAttributes!=held.initial.dwFileAttributes||(now.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT)||((now.dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY)!=0)!=held.directory){out.code=Code::IdentityUnavailable;return out;}
  if(held.privateAcl){const Code acl=inspectAcl(held.handle.get(),held.directory,user);if(acl!=Code::Private){out.code=acl;return out;}}
  if(i+1==lease.paths.size()){
   const auto size=(static_cast<std::uint64_t>(now.nFileSizeHigh)<<32)|now.nFileSizeLow;
   if(!avm_lease::completedFile(held.directory,size,now.nNumberOfLinks)||!GetFileInformationByHandleEx(held.handle.get(),FileIdInfo,&out.identity,sizeof(out.identity))){out.code=Code::IdentityUnavailable;return out;}
   out.code=Code::Private;out.exists=true;out.directory=false;out.legacy=now;
  }
 }
 return out;
}

}
