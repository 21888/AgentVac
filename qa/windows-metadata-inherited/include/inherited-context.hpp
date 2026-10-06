#pragma once
#ifndef _WIN32
#error inherited-context.hpp requires the Windows SDK; inherited-policy.hpp is portable.
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <memory>
#include <utility>
#include <vector>
#include "inherited-policy.hpp"

namespace avm_inherited {
struct CloseHandleOnly {
  void operator()(void* h) const noexcept {
    if (h && h != INVALID_HANDLE_VALUE) CloseHandle(h);
  }
};
using Handle = std::unique_ptr<void, CloseHandleOnly>;

// Keep this object alive through the entire observation. It owns all handles;
// input remains borrowed. Holding a process handle prevents PID reuse while
// that process object is referenced. These handles cannot adjust privileges.
struct BoundCaller {
  Handle process, callerToken, currentToken;
  std::vector<std::uint8_t> user;
  std::size_t userOffset = 0;
  bool elevated = false;
  PSID userSid() const noexcept {
    if (user.empty() || userOffset >= user.size()) return nullptr;
    return const_cast<std::uint8_t*>(user.data() + userOffset);
  }
};

namespace detail {
constexpr DWORD kMaxTokenBytes = 65536;
constexpr DWORD kMaxPrivileges = 1024;
inline bool sameLuid(const LUID& a, const LUID& b) noexcept {
  return a.LowPart == b.LowPart && a.HighPart == b.HighPart;
}
inline std::uint64_t luidValue(const LUID& v) noexcept {
  return static_cast<std::uint64_t>(static_cast<std::uint32_t>(v.HighPart)) << 32 |
    static_cast<std::uint64_t>(v.LowPart);
}
template<class T> inline bool fixed(HANDLE token, TOKEN_INFORMATION_CLASS kind, T& out) {
  DWORD count = 0;
  return GetTokenInformation(token, kind, &out, static_cast<DWORD>(sizeof(out)), &count) &&
    count == sizeof(out);
}
inline bool variable(HANDLE token, TOKEN_INFORMATION_CLASS kind, DWORD minimum,
                     std::vector<std::uint8_t>& out) {
  DWORD size = 0;
  if (GetTokenInformation(token, kind, nullptr, 0, &size) ||
      GetLastError() != ERROR_INSUFFICIENT_BUFFER || size < minimum ||
      size > kMaxTokenBytes) return false;
  out.resize(size);
  DWORD returned = 0;
  // No retry for a changing size or partially populated query.
  return GetTokenInformation(token, kind, out.data(), size, &returned) && returned == size;
}
inline bool sidInBuffer(const std::vector<std::uint8_t>& bytes, PSID sid,
                        std::size_t minimumOffset, std::size_t& offset, DWORD& length) {
  if (!sid || bytes.empty()) return false;
  const auto base = reinterpret_cast<std::uintptr_t>(bytes.data());
  const auto address = reinterpret_cast<std::uintptr_t>(sid);
  if (address < base || address - base > bytes.size()) return false;
  offset = static_cast<std::size_t>(address - base);
  if (offset < minimumOffset || bytes.size() - offset < 8) return false;
  const auto* header = bytes.data() + offset;
  if (header[0] != SID_REVISION || !header[1] || header[1] > SID_MAX_SUB_AUTHORITIES) return false;
  length = 8u + 4u * static_cast<DWORD>(header[1]);
  return length <= bytes.size() - offset && IsValidSid(sid) && GetLengthSid(sid) == length;
}
inline ThreadState threadState() {
  HANDLE raw = nullptr;
  const BOOL opened = OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, TRUE, &raw);
  const DWORD error = opened ? ERROR_SUCCESS : GetLastError();
  Handle token(raw);
  if (opened) return ThreadState::Present;
  return error == ERROR_NO_TOKEN ? ThreadState::Absent : ThreadState::Unknown;
}
inline Outcome alive(HANDLE process) {
  // SYNCHRONIZE is read-only here; exit code 259 is deliberately not a proof.
  const DWORD state = WaitForSingleObject(process, 0);
  if (state == WAIT_TIMEOUT) return Outcome::Verified;
  if (state == WAIT_OBJECT_0) return Outcome::PeerRejected;
  return Outcome::Unavailable;
}
inline bool openToken(HANDLE process, Handle& token) {
  HANDLE raw = nullptr;
  if (!OpenProcessToken(process, TOKEN_QUERY, &raw)) return false;
  token.reset(raw);
  return raw != nullptr && raw != INVALID_HANDLE_VALUE;
}
inline bool stableStatistics(const TOKEN_STATISTICS& a, const TOKEN_STATISTICS& b) {
  return sameLuid(a.TokenId, b.TokenId) && sameLuid(a.ModifiedId, b.ModifiedId) &&
    sameLuid(a.AuthenticationId, b.AuthenticationId) && a.TokenType == b.TokenType &&
    a.PrivilegeCount == b.PrivilegeCount && a.GroupCount == b.GroupCount;
}
struct Snapshot {
  TokenEvidence evidence;
  TOKEN_STATISTICS statistics{};
  std::vector<std::uint8_t> user;
  std::size_t userOffset = 0;
  DWORD userLength = 0;
  PSID sid() const { return const_cast<std::uint8_t*>(user.data() + userOffset); }
};
inline bool snapshot(HANDLE token, const LUID& backup, const LUID& restore, Snapshot& out) {
  TOKEN_STATISTICS before{}, after{};
  TOKEN_TYPE type = TokenImpersonation;
  TOKEN_ELEVATION elevation{};
  DWORD session = 0;
  std::vector<std::uint8_t> integrity, privileges;
  if (!fixed(token, TokenStatistics, before) || !fixed(token, TokenType, type) ||
      !fixed(token, TokenElevation, elevation) ||
      !fixed(token, TokenSessionId, session) ||
      !variable(token, TokenUser, static_cast<DWORD>(sizeof(TOKEN_USER)), out.user) ||
      !variable(token, TokenIntegrityLevel, static_cast<DWORD>(sizeof(TOKEN_MANDATORY_LABEL)), integrity) ||
      !variable(token, TokenPrivileges, static_cast<DWORD>(offsetof(TOKEN_PRIVILEGES, Privileges)), privileges)) return false;
  TOKEN_USER user{};
  std::memcpy(&user, out.user.data(), sizeof(user));
  if (!sidInBuffer(out.user, user.User.Sid, sizeof(TOKEN_USER), out.userOffset, out.userLength)) return false;
  out.evidence.identity = classifyUserSid(out.user.data() + out.userOffset, out.userLength);
  if (out.evidence.identity == PrimaryIdentity::Unknown) return false;
  TOKEN_MANDATORY_LABEL label{};
  std::memcpy(&label, integrity.data(), sizeof(label));
  std::size_t integrityOffset = 0; DWORD integrityLength = 0;
  if (!sidInBuffer(integrity, label.Label.Sid, sizeof(TOKEN_MANDATORY_LABEL),
                   integrityOffset, integrityLength) || integrityLength != 12 ||
      (label.Label.Attributes & SE_GROUP_INTEGRITY) == 0) return false;
  const auto* integritySid = integrity.data() + integrityOffset;
  // A mandatory label is S-1-16-RID, not an arbitrary SID's final RID.
  if (integritySid[2] || integritySid[3] || integritySid[4] || integritySid[5] ||
      integritySid[6] || integritySid[7] != 16) return false;
  DWORD integrityRid = 0;
  std::memcpy(&integrityRid, integritySid + 8, sizeof(integrityRid));

  DWORD count = 0;
  std::memcpy(&count, privileges.data(), sizeof(count));
  const std::size_t headerSize = offsetof(TOKEN_PRIVILEGES, Privileges);
  if (count > kMaxPrivileges || count != before.PrivilegeCount ||
      headerSize + static_cast<std::size_t>(count) * sizeof(LUID_AND_ATTRIBUTES) != privileges.size()) return false;
  std::vector<LUID> seen;
  seen.reserve(count);
  for (DWORD i = 0; i < count; ++i) {
    LUID_AND_ATTRIBUTES privilege{};
    std::memcpy(&privilege, privileges.data() + headerSize +
      static_cast<std::size_t>(i) * sizeof(privilege), sizeof(privilege));
    constexpr DWORD allowedAttributes = SE_PRIVILEGE_ENABLED_BY_DEFAULT | SE_PRIVILEGE_ENABLED |
      SE_PRIVILEGE_REMOVED | SE_PRIVILEGE_USED_FOR_ACCESS;
    if ((privilege.Attributes & ~allowedAttributes) != 0 ||
        ((privilege.Attributes & SE_PRIVILEGE_REMOVED) && (privilege.Attributes & SE_PRIVILEGE_ENABLED))) return false;
    for (const auto& value : seen) if (sameLuid(value, privilege.Luid)) return false;
    seen.push_back(privilege.Luid);
    if ((privilege.Attributes & SE_PRIVILEGE_ENABLED) != 0) {
      if (sameLuid(privilege.Luid, backup)) out.evidence.backupEnabled = true;
      if (sameLuid(privilege.Luid, restore)) out.evidence.restoreEnabled = true;
    }
  }
  if (!fixed(token, TokenStatistics, after) || !stableStatistics(before, after) ||
      type != after.TokenType) return false;
  out.statistics = after;
  out.evidence.queried = out.evidence.stable = true;
  out.evidence.primary = type == TokenPrimary;
  out.evidence.elevated = elevation.TokenIsElevated != 0;
  out.evidence.authenticationId = luidValue(after.AuthenticationId);
  out.evidence.session = session;
  out.evidence.integrity = integrityRid;
  return true;
}
inline bool stillSamePrimary(HANDLE process, const TOKEN_STATISTICS& saved) {
  Handle reopened;
  TOKEN_STATISTICS now{};
  return openToken(process, reopened) && fixed(reopened.get(), TokenStatistics, now) &&
    stableStatistics(saved, now);
}
} // namespace detail

inline Outcome bindCaller(HANDLE input, DWORD expectedCallerPid, BoundCaller& bound) noexcept {
  bound = {};
  try {
    Evidence evidence;
    evidence.expectedPid = expectedCallerPid;
    evidence.currentPid = GetCurrentProcessId();
    if (!expectedCallerPid || !evidence.currentPid || expectedCallerPid == evidence.currentPid)
      return Outcome::PeerRejected;
    evidence.thread = detail::threadState();
    if (evidence.thread == ThreadState::Present) return Outcome::ContextRejected;
    if (evidence.thread != ThreadState::Absent) return Outcome::Unavailable;
    if (!input || input == INVALID_HANDLE_VALUE) return Outcome::PeerRejected;
    const DWORD inputType = GetFileType(input);
    if (inputType == FILE_TYPE_UNKNOWN) return Outcome::Unavailable;
    if (inputType != FILE_TYPE_PIPE) return Outcome::PeerRejected;
    ULONG serverPid = 0;
    if (!GetNamedPipeServerProcessId(input, &serverPid)) return Outcome::Unavailable;
    if (!serverPid || serverPid != expectedCallerPid || serverPid == evidence.currentPid)
      return Outcome::PeerRejected;
    BoundCaller candidate;
    candidate.process.reset(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
                                        FALSE, expectedCallerPid));
    if (!candidate.process) return Outcome::Unavailable;
    const DWORD openedPid = GetProcessId(candidate.process.get());
    if (!openedPid) return Outcome::Unavailable;
    if (openedPid != expectedCallerPid) return Outcome::PeerRejected;
    auto active = detail::alive(candidate.process.get());
    if (active != Outcome::Verified) return active;
    if (!detail::openToken(GetCurrentProcess(), candidate.currentToken) ||
        !detail::openToken(candidate.process.get(), candidate.callerToken)) return Outcome::Unavailable;
    LUID backup{}, restore{};
    // Local lookup only; no privilege adjustment or remote account resolution.
    if (!LookupPrivilegeValueW(nullptr, L"SeBackupPrivilege", &backup) ||
        !LookupPrivilegeValueW(nullptr, L"SeRestorePrivilege", &restore) ||
        detail::sameLuid(backup, restore)) return Outcome::Unavailable;
    detail::Snapshot current, caller;
    if (!detail::snapshot(candidate.currentToken.get(), backup, restore, current) ||
        !detail::snapshot(candidate.callerToken.get(), backup, restore, caller)) return Outcome::Unavailable;
    evidence.current = current.evidence;
    evidence.caller = caller.evidence;
    evidence.userSid = current.userLength == caller.userLength &&
      std::memcmp(current.sid(), caller.sid(), current.userLength) == 0 &&
      EqualSid(current.sid(), caller.sid()) ? Match::Equal : Match::Different;
    // Recheck the actual endpoint, liveness, thread and primary-token identities
    // after the multi-query snapshots. Do not return approval for stale evidence.
    ULONG serverAfter = 0;
    if (!GetNamedPipeServerProcessId(input, &serverAfter)) return Outcome::Unavailable;
    if (serverAfter != serverPid) return Outcome::PeerRejected;
    active = detail::alive(candidate.process.get());
    if (active != Outcome::Verified) return active;
    evidence.thread = detail::threadState();
    if (!detail::stillSamePrimary(GetCurrentProcess(), current.statistics) ||
        !detail::stillSamePrimary(candidate.process.get(), caller.statistics)) return Outcome::Unavailable;
    evidence.pipeServerPid = serverAfter;
    evidence.peerQueried = evidence.peerActive = true;
    const Outcome result = decide(evidence);
    if (result != Outcome::Verified) return result;
    candidate.user = std::move(current.user);
    candidate.userOffset = current.userOffset;
    candidate.elevated = evidence.current.elevated;
    bound = std::move(candidate);
    return Outcome::Verified;
  } catch (...) {
    bound = {};
    return Outcome::Unavailable;
  }
}
} // namespace avm_inherited
