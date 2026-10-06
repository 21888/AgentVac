#pragma once
#include "core.hpp"
namespace avm_inherited {
constexpr std::size_t kMaxRequest = 16 + 2 * avm::kMaxUtf8;
struct Request { avm::Request target; std::u16string scope; std::uint32_t callerPid = 0; };
inline bool parseRequest(const std::vector<std::uint8_t>& body, Request& out) {
  if (body.size() < 22 || body.size() > kMaxRequest || body[0] != 'A' || body[1] != 'V' || body[2] != 'M' || body[3] != '2' || body[4] > 1 || body[5] > 3 || body[6] || body[7]) return false;
  out.callerPid = avm::u32(body.data()+8); const auto scopeLength = avm::u32(body.data()+12);
  if (!out.callerPid || scopeLength < 3 || scopeLength > avm::kMaxUtf8 || scopeLength > body.size()-19) return false;
  out.target.acl = body[4] == 1; out.target.directory = (body[5] & 1) != 0; out.target.missing = (body[5] & 2) != 0;
  if (out.target.missing && (out.target.acl || !out.target.directory)) return false;
  const std::vector<std::uint8_t> scope(body.begin()+16,body.begin()+16+scopeLength);
  return avm::utf8(scope,0,out.scope) && avm::canonicalize(out.scope) && avm::utf8(body,16+scopeLength,out.target.path) && avm::canonicalize(out.target.path);
}
}
