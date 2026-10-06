#include "../include/inherited-policy.hpp"
#include <array>
#include <cassert>
#include <initializer_list>
#include <iostream>
#include <random>
#include <vector>

namespace {
using namespace avm_inherited;
Evidence permitted() {
  Evidence e;
  e.expectedPid = e.pipeServerPid = 100;
  e.currentPid = 200;
  e.peerQueried = e.peerActive = true;
  e.thread = ThreadState::Absent;
  e.current.queried = e.current.stable = e.current.primary = true;
  e.current.identity = PrimaryIdentity::OtherCurrentUser;
  e.current.authenticationId = 0x12345678000000abULL;
  e.current.session = 1;
  e.current.integrity = 0x2000;
  e.caller = e.current;
  e.userSid = Match::Equal;
  return e;
}
std::vector<std::uint8_t> sid(std::uint8_t authority,
                            std::initializer_list<std::uint32_t> values) {
  std::vector<std::uint8_t> result(8 + 4 * values.size());
  result[0] = 1; result[1] = static_cast<std::uint8_t>(values.size()); result[7] = authority;
  std::size_t offset = 8;
  for (const auto value : values) {
    for (unsigned j = 0; j < 4; ++j) result[offset++] = static_cast<std::uint8_t>(value >> (8 * j));
  }
  return result;
}
PrimaryIdentity classify(const std::vector<std::uint8_t>& value) {
  return classifyUserSid(value.data(), value.size());
}
// Deliberately checks the acceptance conjunction independently of refusal order.
bool acceptanceOracle(const Evidence& e) {
  if (e.expectedPid == 0 || e.currentPid == 0 || e.expectedPid == e.currentPid ||
      e.pipeServerPid != e.expectedPid || !e.peerQueried || !e.peerActive ||
      e.thread != ThreadState::Absent || e.userSid != Match::Equal) return false;
  for (const auto* t : {&e.current, &e.caller}) {
    if (!t->queried || !t->stable || !t->primary ||
        t->identity != PrimaryIdentity::OtherCurrentUser || t->backupEnabled ||
        t->restoreEnabled || t->integrity >= 0x4000) return false;
  }
  return e.current.authenticationId == e.caller.authenticationId &&
    e.current.session == e.caller.session && e.current.integrity == e.caller.integrity;
}
}

int main() {
  using namespace avm_inherited;
  assert(decide({}) != Outcome::Verified);
  assert(decide(permitted()) == Outcome::Verified);
  auto e = permitted();
  e.current.elevated = e.caller.elevated = true;
  e.current.integrity = e.caller.integrity = 0x3000;
  assert(decide(e) == Outcome::Verified); // Inherited administrator, ordinary rights.
  for (unsigned bits = 0; bits < 4; ++bits) {
    e.current.elevated = (bits & 1u) != 0; e.caller.elevated = (bits & 2u) != 0;
    assert(decide(e) == Outcome::Verified); // Elevation is diagnostic, not a gate.
  }
  // No interactive/window-station/service-group facts are required or inferred.
  // Identical session 0 is valid, including a headless ordinary service logon.
  e.current.session = e.caller.session = 0;
  assert(decide(e) == Outcome::Verified);
  for (const auto rid : {0u, 0x1000u, 0x2000u, 0x2100u, 0x3000u, 0x3fffu}) {
    e.current.integrity = e.caller.integrity = rid;
    assert(decide(e) == Outcome::Verified);
  }
  for (const auto rid : {0x4000u, 0x5000u, 0xffffffffu}) {
    e.current.integrity = e.caller.integrity = rid;
    assert(decide(e) == Outcome::ContextRejected);
  }
  for (const bool caller : {false, true}) {
    auto& target = caller ? e.caller : e.current;
    for (const auto field : {&TokenEvidence::backupEnabled, &TokenEvidence::restoreEnabled}) {
      e = permitted(); target.*field = true;
      assert(decide(e) == Outcome::ContextRejected);
    }
    for (const auto field : {&TokenEvidence::queried, &TokenEvidence::stable}) {
      e = permitted(); target.*field = false;
      assert(decide(e) == Outcome::Unavailable);
    }
    e = permitted(); target.primary = false;
    assert(decide(e) == Outcome::ContextRejected);
    for (const auto identity : {PrimaryIdentity::Anonymous, PrimaryIdentity::Iusr,
         PrimaryIdentity::LocalSystem, PrimaryIdentity::LocalService,
         PrimaryIdentity::NetworkService, PrimaryIdentity::VirtualService}) {
      e = permitted(); target.identity = identity;
      assert(decide(e) == Outcome::ContextRejected);
    }
    e = permitted(); target.identity = PrimaryIdentity::Unknown;
    assert(decide(e) == Outcome::Unavailable);
  }
  e = permitted(); e.thread = ThreadState::Present; assert(decide(e) == Outcome::ContextRejected);
  e.thread = ThreadState::Unknown; assert(decide(e) == Outcome::Unavailable);
  e = permitted(); e.peerQueried = false; assert(decide(e) == Outcome::Unavailable);
  e = permitted(); e.peerActive = false; assert(decide(e) == Outcome::PeerRejected);
  e = permitted(); e.expectedPid = 0; assert(decide(e) == Outcome::PeerRejected);
  e = permitted(); e.currentPid = e.expectedPid; assert(decide(e) == Outcome::PeerRejected);
  e = permitted(); e.pipeServerPid++; assert(decide(e) == Outcome::PeerRejected);
  e = permitted(); e.userSid = Match::Different; assert(decide(e) == Outcome::PeerRejected);
  e.userSid = Match::Unknown; assert(decide(e) == Outcome::Unavailable);
  e = permitted(); e.caller.authenticationId ^= 1ULL << 32; assert(decide(e) == Outcome::PeerRejected);
  e = permitted(); e.caller.session++; assert(decide(e) == Outcome::PeerRejected);
  e = permitted(); e.caller.integrity++; assert(decide(e) == Outcome::PeerRejected);

  assert(classify(sid(5, {7})) == PrimaryIdentity::Anonymous);
  assert(classify(sid(5, {17})) == PrimaryIdentity::Iusr);
  assert(classify(sid(5, {18})) == PrimaryIdentity::LocalSystem);
  assert(classify(sid(5, {19})) == PrimaryIdentity::LocalService);
  assert(classify(sid(5, {20})) == PrimaryIdentity::NetworkService);
  for (std::uint32_t base = 80; base <= 111; ++base)
    assert(classify(sid(5, {base, 1, 2, 3, 4, 5})) == PrimaryIdentity::VirtualService);
  assert(classify(sid(5, {80, 0})) == PrimaryIdentity::VirtualService);
  assert(classify(sid(5, {82, 0})) == PrimaryIdentity::VirtualService);
  for (const auto& ordinary : {sid(5, {21, 80, 82, 111, 500}), sid(12, {1, 2, 3, 4, 5}),
                              sid(5, {21, 18, 19, 20, 1001})}) {
    assert(classify(ordinary) == PrimaryIdentity::OtherCurrentUser);
    e = permitted(); e.current.identity = e.caller.identity = classify(ordinary);
    assert(decide(e) == Outcome::Verified); // Local/domain/AzureAD shapes aren't an allowlist.
  }
  auto broken = sid(5, {21, 1, 2, 3, 1001});
  broken.pop_back(); assert(classify(broken) == PrimaryIdentity::Unknown);
  broken = sid(5, {18}); broken[0] = 2; assert(classify(broken) == PrimaryIdentity::Unknown);
  broken = sid(5, {}); assert(classify(broken) == PrimaryIdentity::Unknown);
  assert(classifyUserSid(nullptr, 100) == PrimaryIdentity::Unknown);

  // Exhaustive independent boolean evidence: both tokens' five safety booleans,
  // both diagnostic elevation bits, and the peer's query/liveness evidence.
  for (unsigned bits = 0; bits < (1u << 14); ++bits) {
    e = permitted(); unsigned bit = 0;
    for (auto* token : {&e.current, &e.caller}) {
      for (const auto field : {&TokenEvidence::queried, &TokenEvidence::stable,
           &TokenEvidence::primary, &TokenEvidence::backupEnabled,
           &TokenEvidence::restoreEnabled, &TokenEvidence::elevated})
        token->*field = (bits & (1u << bit++)) != 0;
    }
    e.peerQueried = (bits & (1u << bit++)) != 0;
    e.peerActive = (bits & (1u << bit)) != 0;
    assert((decide(e) == Outcome::Verified) == acceptanceOracle(e));
  }
  std::mt19937 random(0x1ace2026);
  unsigned verified = 0;
  for (unsigned n = 0; n < 100000; ++n) {
    e = permitted();
    if (n % 4 != 0) {
      e.expectedPid = static_cast<std::uint32_t>(random());
      e.currentPid = static_cast<std::uint32_t>(random());
      e.pipeServerPid = random() % 2 ? e.expectedPid : static_cast<std::uint32_t>(random());
      e.peerQueried = random() % 2 != 0; e.peerActive = random() % 2 != 0;
      e.thread = static_cast<ThreadState>(random() % 5);
      e.userSid = static_cast<Match>(random() % 5);
      for (auto* token : {&e.current, &e.caller}) {
        token->queried = random() % 2 != 0; token->stable = random() % 2 != 0;
        token->primary = random() % 2 != 0; token->elevated = random() % 2 != 0;
        token->backupEnabled = random() % 2 != 0; token->restoreEnabled = random() % 2 != 0;
        token->identity = static_cast<PrimaryIdentity>(random() % 12);
        token->session = random() % 4; token->authenticationId = random() % 4;
        token->integrity = static_cast<std::uint32_t>((random() % 6) * 0x1000);
      }
    }
    const bool accepted = decide(e) == Outcome::Verified;
    assert(accepted == acceptanceOracle(e));
    if (accepted) ++verified;
    std::vector<std::uint8_t> bytes(random() % 80);
    for (auto& byte : bytes) byte = static_cast<std::uint8_t>(random());
    if (n % 2 == 0 && bytes.size() >= 8) { bytes[0] = 1; bytes[1] = static_cast<std::uint8_t>(random() % 20); }
    const auto identity = classify(bytes);
    if (identity != PrimaryIdentity::Unknown)
      assert(bytes[0] == 1 && bytes[1] >= 1 && bytes[1] <= 15 && bytes.size() == 8u + 4u * bytes[1]);
  }
  assert(verified >= 25000);
  std::cout << "inherited policy: 16384 boolean cases, 100000 evidence/SID fuzz cases passed; nativeWindows=NOT_RUN\n";
}
