#pragma once
#include <algorithm>
#include <cstdint>
#include <string>
#include <vector>

namespace avm {
constexpr std::size_t kMaxUtf8 = 16384, kMaxUtf16 = 4096, kMaxComponents = 128;
constexpr std::size_t kMaxRequest = 8 + kMaxUtf8, kResponseSize = 64;
enum class Code : std::uint8_t { Local = 0, Private = 1, InvalidRequest = 2,
  LocalityRejected = 3, AclRejected = 4, MetadataUnavailable = 5,
  Timeout = 6, IdentityUnavailable = 7 };
struct Request { std::u16string path; bool acl = false, directory = false, missing = false; };

inline bool utf8(const std::vector<std::uint8_t>& input, std::size_t begin, std::u16string& out) {
  out.clear();
  if (input.size() < begin || input.size() - begin > kMaxUtf8) return false;
  for (std::size_t i = begin; i < input.size();) {
    std::uint32_t c = input[i++]; unsigned extra = 0; std::uint32_t minimum = 0;
    if (c <= 0x7f) {}
    else if (c >= 0xc2 && c <= 0xdf) { c &= 0x1f; extra = 1; minimum = 0x80; }
    else if (c >= 0xe0 && c <= 0xef) { c &= 0x0f; extra = 2; minimum = 0x800; }
    else if (c >= 0xf0 && c <= 0xf4) { c &= 0x07; extra = 3; minimum = 0x10000; }
    else return false;
    if (input.size() - i < extra) return false;
    while (extra--) { const auto b = input[i++]; if ((b & 0xc0) != 0x80) return false; c = (c << 6) | (b & 0x3f); }
    if (c < minimum || c > 0x10ffff || (c >= 0xd800 && c <= 0xdfff)) return false;
    if (c <= 0xffff) out.push_back(static_cast<char16_t>(c));
    else { c -= 0x10000; out.push_back(static_cast<char16_t>(0xd800 + (c >> 10))); out.push_back(static_cast<char16_t>(0xdc00 + (c & 0x3ff))); }
    if (out.size() > kMaxUtf16) return false;
  }
  return true;
}
inline char16_t upper(char16_t c) { return c >= u'a' && c <= u'z' ? static_cast<char16_t>(c - u'a' + u'A') : c; }
inline bool reserved(std::u16string part) {
  part = part.substr(0, part.find(u'.')); for (auto& c : part) c = upper(c);
  if (part == u"CON" || part == u"CONIN$" || part == u"CONOUT$" || part == u"PRN" || part == u"AUX" || part == u"NUL") return true;
  if (part.size() != 4 || (part.substr(0,3) != u"COM" && part.substr(0,3) != u"LPT")) return false;
  const auto c = part[3]; return (c >= u'1' && c <= u'9') || c == 0x00b9 || c == 0x00b2 || c == 0x00b3;
}
inline bool canonicalize(std::u16string& path) {
  if (path.empty() || path.size() > kMaxUtf16) return false;
  for (std::size_t i = 0; i < path.size(); ++i) {
    const auto c = path[i]; if (c <= 0x1f || c == 0x7f) return false;
    if (c >= 0xd800 && c <= 0xdbff) { if (++i == path.size() || path[i] < 0xdc00 || path[i] > 0xdfff) return false; }
    else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  if (path.compare(0, 4, u"\\\\?\\") == 0) { if (path.find(u'/') != std::u16string::npos) return false; path.erase(0,4); }
  else { if (path.size() < 3 || path[1] != u':' || (path[2] != u'/' && path[2] != u'\\')) return false; std::replace(path.begin(),path.end(),u'/',u'\\'); }
  if (path.size() < 3 || upper(path[0]) < u'A' || upper(path[0]) > u'Z' || path[1] != u':' || path[2] != u'\\') return false;
  if (path.size() > 3 && path.back() == u'\\') { path.pop_back(); if (path.size() == 3) return false; }
  std::size_t begin = 3, count = 0;
  while (begin < path.size()) {
    const auto end = path.find(u'\\', begin); const auto part = path.substr(begin, end == std::u16string::npos ? end : end - begin);
    if (++count > kMaxComponents || part.empty() || part == u"." || part == u".." || part.back() == u'.' || part.back() == u' ' || reserved(part) || part.find_first_of(u"<>:\"|?*") != std::u16string::npos) return false;
    if (end == std::u16string::npos) break;
    begin = end + 1;
    if (begin == path.size()) return false;
  }
  path[0] = upper(path[0]); return true;
}
inline bool parse(const std::vector<std::uint8_t>& body, Request& result) {
  if (body.size() < 11 || body.size() > kMaxRequest || body[0] != 'A' || body[1] != 'V' || body[2] != 'M' || body[3] != '1' || body[4] > 1 || body[5] > 3 || body[6] || body[7]) return false;
  result.acl = body[4] == 1; result.directory = (body[5] & 1) != 0; result.missing = (body[5] & 2) != 0;
  if (result.missing && (result.acl || !result.directory)) return false;
  return utf8(body, 8, result.path) && canonicalize(result.path);
}
inline bool nativeMapping(const std::u16string& s) {
  const std::u16string prefix = u"\\Device\\HarddiskVolume";
  if (s.size() <= prefix.size() || s.size() > prefix.size() + 20) return false;
  for (std::size_t i = 0; i < prefix.size(); ++i) if (upper(s[i]) != upper(prefix[i])) return false;
  for (std::size_t i = prefix.size(); i < s.size(); ++i) if (s[i] < u'0' || s[i] > u'9') return false;
  return true;
}
inline bool sidShape(unsigned revision, unsigned subAuthorities) { return revision == 1 && subAuthorities >= 1 && subAuthorities <= 14; }
enum class Principal : std::uint8_t { Current, System, Administrators, Other, Invalid };
enum class Kind : std::uint8_t { Allow, Deny, Unknown };
struct Ace { Principal principal; std::int64_t rights; Kind kind; bool inherited; int inheritance; int propagation; };
inline bool allowed(Principal p) { return p == Principal::Current || p == Principal::System || p == Principal::Administrators; }
// Literal policy port. In particular, valid deny ACEs for Other stay permitted.
inline bool privateAcl(Principal owner, bool canonical, const std::vector<Ace>& entries, bool requireInheritance) {
  if (!allowed(owner) || !canonical || entries.empty() || entries.size() > 128) return false;
  bool access = false, inheritance = !requireInheritance;
  for (const auto& ace : entries) {
    if (ace.principal == Principal::Invalid || ace.rights <= 0 || ace.rights > 0x1fffff || ace.kind == Kind::Unknown || ace.inheritance < 0 || ace.inheritance > 3 || ace.propagation < 0 || ace.propagation > 3) return false;
    if (ace.kind == Kind::Allow && !allowed(ace.principal)) return false;
    if (ace.kind == Kind::Allow && ace.principal == Principal::Current && (ace.rights & 3) == 3 && (ace.propagation & 2) == 0) access = true;
    if (ace.kind == Kind::Allow && ace.principal == Principal::Current && ace.inheritance == 3 && ace.propagation == 0) inheritance = true;
    if (ace.kind == Kind::Deny && allowed(ace.principal)) return false;
  }
  return access && inheritance;
}
// .NET CommonAcl.CanonicalCheck categories, for the supported ordinary ACEs.
inline bool canonicalAcl(const std::vector<Ace>& entries) {
  int stage = 0;
  for (const auto& ace : entries) {
    if (ace.kind == Kind::Unknown) return false;
    const int next = ace.inherited ? 2 : ace.kind == Kind::Deny ? 0 : 1;
    if (next < stage) return false;
    stage = next;
  }
  return true;
}
inline std::uint32_t u32(const std::uint8_t* p) { return static_cast<std::uint32_t>(p[0]) | static_cast<std::uint32_t>(p[1]) << 8 | static_cast<std::uint32_t>(p[2]) << 16 | static_cast<std::uint32_t>(p[3]) << 24; }
inline void put32(std::uint8_t* p, std::uint32_t n) { for (unsigned i=0;i<4;++i) p[i]=static_cast<std::uint8_t>(n >> (8*i)); }
inline void put64(std::uint8_t* p, std::uint64_t n) { for (unsigned i=0;i<8;++i) p[i]=static_cast<std::uint8_t>(n >> (8*i)); }
} // namespace avm
