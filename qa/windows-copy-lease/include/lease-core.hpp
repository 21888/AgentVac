#pragma once
#include "inherited-request.hpp"
#include <array>
#include <algorithm>
namespace avm_lease {
constexpr std::size_t kNonceBytes = 16;
constexpr std::size_t kMaxRequest = avm_inherited::kMaxRequest + 20;
constexpr std::size_t kControlBytes = 24;
constexpr std::size_t kResponseBytes = 24 + 4 + avm::kResponseSize;
constexpr std::uint64_t kCopyLimit = 16u * 1024u * 1024u;
constexpr std::uint32_t kLeaseMs = 30000;
// Explicit rights participating in MS-FSA sharing checks. Directory0x20 is
// FILE_TRAVERSE (not enumeration); regular-file0x1 is FILE_READ_DATA. No target
// content operation is performed. Constants are verified against WinNT below.
struct RetainedOpenPolicy { std::uint32_t desiredAccess; std::uint32_t shareAccess; };
constexpr RetainedOpenPolicy retainedOpenPolicy(bool directory,bool inspectSecurity) {
 return {0x80u | (inspectSecurity?0x20000u:0u) | (directory?0x20u:0x1u), 0x1u | (directory?0u:0x2u)};
}
using Nonce = std::array<std::uint8_t,kNonceBytes>;
enum class Phase : std::uint8_t { Ready=1, Released=2, Refused=3, Cancelled=4 };
enum class Reason : std::uint8_t { None=0, Nonempty=1, Hardlink=2, NotRegular=3, UnsupportedFilesystem=4, SharingConflict=5 };
enum class Control : std::uint8_t { Release=1, Cancel=2 };
struct Request { Nonce nonce{}; avm_inherited::Request inherited; };
inline bool nonzero(const Nonce& nonce) { return std::any_of(nonce.begin(),nonce.end(),[](std::uint8_t b){return b!=0;}); }
inline bool parseRequest(const std::vector<std::uint8_t>& bytes, Request& out) {
  if(bytes.size()<42 || bytes.size()>kMaxRequest || !std::equal(bytes.begin(),bytes.begin()+4,"AVL2")) return false;
  Request candidate;
  std::copy(bytes.begin()+4,bytes.begin()+20,candidate.nonce.begin());
  if(!nonzero(candidate.nonce)) return false;
  const std::vector<std::uint8_t> body(bytes.begin()+20,bytes.end());
  if(!avm_inherited::parseRequest(body,candidate.inherited) || !candidate.inherited.target.acl || candidate.inherited.target.directory || candidate.inherited.target.missing) return false;
  out=std::move(candidate);return true;
}
inline bool parseControl(const std::vector<std::uint8_t>& bytes,const Nonce& nonce,Control& value) {
  if(bytes.size()!=kControlBytes || !std::equal(bytes.begin(),bytes.begin()+4,"AVC2") || bytes[4]<1 || bytes[4]>2 || bytes[5] || bytes[6] || bytes[7] || !std::equal(bytes.begin()+8,bytes.end(),nonce.begin())) return false;
  value=static_cast<Control>(bytes[4]);return true;
}
inline bool initialFile(bool directory,std::uint64_t size,std::uint32_t links) { return !directory && size==0 && links==1; }
inline bool completedFile(bool directory,std::uint64_t size,std::uint32_t links) { return !directory && size<=kCopyLimit && links==1; }
struct Identity {
 std::uint32_t volume32=0;std::uint64_t fileIndex64=0,size=0;std::uint32_t links=0,attributes=0;
 std::uint64_t volume64=0;std::array<std::uint8_t,16> fileId128{};
};
using Reply=std::array<std::uint8_t,4+kResponseBytes>;
inline bool makeReply(Phase phase,const Nonce& nonce,avm::Code code,const Identity* identity,Reply& bytes,Reason reason=Reason::None){
 const bool success=phase!=Phase::Refused;
 const auto detail=static_cast<std::uint8_t>(reason);
 if(detail>5 || (success&&reason!=Reason::None) ||
   ((reason==Reason::Nonempty||reason==Reason::Hardlink||reason==Reason::NotRegular)&&code!=avm::Code::IdentityUnavailable) ||
   (reason==Reason::UnsupportedFilesystem&&code!=avm::Code::LocalityRejected) ||
   (reason==Reason::SharingConflict&&code!=avm::Code::MetadataUnavailable))return false;
 if(!nonzero(nonce)||static_cast<std::uint8_t>(phase)<1||static_cast<std::uint8_t>(phase)>4||static_cast<std::uint8_t>(code)>10)return false;
 if(success){if(code!=avm::Code::Private||!identity||!identity->fileIndex64||(identity->attributes&0x410u)||!completedFile(false,identity->size,identity->links)||(phase==Phase::Ready&&!initialFile(false,identity->size,identity->links)))return false;}
 else if(code==avm::Code::Private||code==avm::Code::Local||identity)return false;
 bytes.fill(0);avm::put32(bytes.data(),static_cast<std::uint32_t>(kResponseBytes));auto* outer=bytes.data()+4;
 std::copy_n("AVR2",4,outer);outer[4]=static_cast<std::uint8_t>(phase);outer[5]=detail;std::copy(nonce.begin(),nonce.end(),outer+8);
 avm::put32(outer+24,static_cast<std::uint32_t>(avm::kResponseSize));auto* body=outer+28;std::copy_n("AVM2",4,body);body[4]=static_cast<std::uint8_t>(code);
 if(identity){body[5]=5;avm::put64(body+8,identity->volume32);avm::put64(body+16,identity->fileIndex64);avm::put64(body+24,identity->size);avm::put32(body+32,identity->links);avm::put32(body+36,identity->attributes);avm::put64(body+40,identity->volume64);std::copy(identity->fileId128.begin(),identity->fileId128.end(),body+48);}
 return true;
}
} // namespace avm_lease
