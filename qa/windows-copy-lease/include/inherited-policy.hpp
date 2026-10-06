#pragma once
#include <cstddef>
#include <cstdint>

namespace avm_inherited {
// Stable, sanitized outcomes. Never serialize SIDs, account names or OS errors.
enum class Outcome : std::uint8_t { Verified, PeerRejected, ContextRejected, Unavailable };
enum class ThreadState : std::uint8_t { Unknown, Absent, Present };
enum class Match : std::uint8_t { Unknown, Equal, Different };
enum class PrimaryIdentity : std::uint8_t {
  Unknown, OtherCurrentUser, Anonymous, Iusr, LocalSystem, LocalService,
  NetworkService, VirtualService
};
constexpr std::uint32_t kSystemIntegrity = 0x4000;

// Binary SID classification, not a human-account allowlist. Only TokenUser is
// classified; membership of service or virtual-service groups is irrelevant.
inline PrimaryIdentity classifyUserSid(const std::uint8_t* sid, std::size_t size) {
  if (!sid || size < 12 || sid[0] != 1 || sid[1] == 0 || sid[1] > 15 ||
      size != 8u + 4u * static_cast<std::size_t>(sid[1])) return PrimaryIdentity::Unknown;
  const bool ntAuthority = sid[2] == 0 && sid[3] == 0 && sid[4] == 0 &&
    sid[5] == 0 && sid[6] == 0 && sid[7] == 5;
  if (!ntAuthority) return PrimaryIdentity::OtherCurrentUser;
  const std::uint32_t first = static_cast<std::uint32_t>(sid[8]) |
    (static_cast<std::uint32_t>(sid[9]) << 8) |
    (static_cast<std::uint32_t>(sid[10]) << 16) |
    (static_cast<std::uint32_t>(sid[11]) << 24);
  // Microsoft WinNT.h reserves 0x50..0x6f for service/virtual-account SID types.
  // Includes NT SERVICE (80) and IIS APPPOOL (82), but not domain RIDs that
  // happen to contain those numbers further along an ordinary account SID.
  if (first >= 80 && first <= 111) return PrimaryIdentity::VirtualService;
  if (sid[1] == 1) {
    switch (first) {
      case 7: return PrimaryIdentity::Anonymous;
      case 17: return PrimaryIdentity::Iusr;
      case 18: return PrimaryIdentity::LocalSystem;
      case 19: return PrimaryIdentity::LocalService;
      case 20: return PrimaryIdentity::NetworkService;
      default: break;
    }
  }
  return PrimaryIdentity::OtherCurrentUser;
}

struct TokenEvidence {
  bool queried = false, stable = false, primary = false;
  PrimaryIdentity identity = PrimaryIdentity::Unknown;
  bool elevated = false; // Diagnostic only; never a refusal by itself.
  bool backupEnabled = false, restoreEnabled = false;
  std::uint64_t authenticationId = 0;
  std::uint32_t session = 0, integrity = 0;
};
struct Evidence {
  std::uint32_t expectedPid = 0, currentPid = 0, pipeServerPid = 0;
  bool peerQueried = false, peerActive = false;
  ThreadState thread = ThreadState::Unknown;
  TokenEvidence current, caller;
  Match userSid = Match::Unknown;
};

inline bool complete(const TokenEvidence& t) {
  return t.queried && t.stable && t.identity != PrimaryIdentity::Unknown;
}
inline bool contextPermitted(const TokenEvidence& t) {
  return t.primary && t.identity == PrimaryIdentity::OtherCurrentUser &&
    t.integrity < kSystemIntegrity && !t.backupEnabled && !t.restoreEnabled;
}
inline Outcome decide(const Evidence& e) {
  if (!e.expectedPid || !e.currentPid || e.expectedPid == e.currentPid)
    return Outcome::PeerRejected;
  if (!e.peerQueried) return Outcome::Unavailable;
  if (!e.pipeServerPid || e.pipeServerPid != e.expectedPid || !e.peerActive)
    return Outcome::PeerRejected;
  if (e.thread == ThreadState::Present) return Outcome::ContextRejected;
  if (e.thread != ThreadState::Absent || !complete(e.current) || !complete(e.caller))
    return Outcome::Unavailable;
  if (!contextPermitted(e.current) || !contextPermitted(e.caller))
    return Outcome::ContextRejected;
  if (e.userSid == Match::Unknown) return Outcome::Unavailable;
  if (e.userSid != Match::Equal || e.current.authenticationId != e.caller.authenticationId ||
      e.current.session != e.caller.session || e.current.integrity != e.caller.integrity)
    return Outcome::PeerRejected;
  // Session zero, noninteractive operation and service-logon groups are not
  // exclusions. No name lookup or positive account-family classification occurs.
  return Outcome::Verified;
}
} // namespace avm_inherited
