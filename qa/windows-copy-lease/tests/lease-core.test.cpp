#include "../include/lease-core.hpp"
#include <cassert>
#include <iostream>
int main(){
 using namespace avm_lease;
 Nonce nonce{};nonce[0]=1;
 std::vector<std::uint8_t> control(24);std::copy_n("AVC2",4,control.begin());control[4]=1;std::copy(nonce.begin(),nonce.end(),control.begin()+8);
 Control kind=Control::Cancel;assert(parseControl(control,nonce,kind)&&kind==Control::Release);
 std::size_t tests=1;
 for(std::size_t i=0;i<control.size();++i){auto bad=control;bad[i]^=0xff;assert(!parseControl(bad,nonce,kind));++tests;}
 for(std::size_t n=0;n<24;++n){auto shortFrame=control;shortFrame.resize(n);assert(!parseControl(shortFrame,nonce,kind));++tests;}
 auto extra=control;extra.push_back(0);assert(!parseControl(extra,nonce,kind));++tests;
 control[4]=2;assert(parseControl(control,nonce,kind)&&kind==Control::Cancel);++tests;
 assert(initialFile(false,0,1));assert(!initialFile(true,0,1));assert(!initialFile(false,1,1));assert(!initialFile(false,0,2));tests+=4;
 assert(completedFile(false,kCopyLimit,1));assert(!completedFile(false,kCopyLimit+1,1));assert(!completedFile(true,0,1));assert(!completedFile(false,0,2));tests+=4;
 for(std::size_t n=0;n<42;++n){std::vector<std::uint8_t> body(n);Request out;assert(!parseRequest(body,out));++tests;}
 avm_lease::Identity info;info.volume32=12;info.fileIndex64=34;info.links=1;info.attributes=32;Reply reply{};
 assert(makeReply(Phase::Ready,nonce,avm::Code::Private,&info,reply));assert(reply.size()==96&&avm::u32(reply.data())==92&&reply[8]==1&&reply[36]==1&&reply[37]==5);tests+=2;
 info.size=17;assert(makeReply(Phase::Released,nonce,avm::Code::Private,&info,reply));assert(!makeReply(Phase::Ready,nonce,avm::Code::Private,&info,reply));tests+=2;
 info.size=kCopyLimit+1;assert(!makeReply(Phase::Released,nonce,avm::Code::Private,&info,reply));++tests;
 info.size=0;info.attributes=0x410;assert(!makeReply(Phase::Ready,nonce,avm::Code::Private,&info,reply));++tests;
 assert(makeReply(Phase::Refused,nonce,avm::Code::InvalidRequest,nullptr,reply));assert(reply[36]==2&&reply[37]==0);tests+=2;
 assert(!makeReply(Phase::Refused,nonce,avm::Code::Private,&info,reply));assert(!makeReply(Phase::Ready,Nonce{},avm::Code::Private,&info,reply));tests+=2;
 // Test the exact access policy consumed by CreateFileW. Windows static_asserts
 // bind these constants to the SDK. This is not a native sharing proof.
 for(bool directory:{false,true})for(bool acl:{false,true}){
  const auto policy=retainedOpenPolicy(directory,acl);
  assert((policy.desiredAccess & (directory?0x20u:0x1u))!=0);++tests;
  assert((policy.desiredAccess & 0x80u)!=0);++tests;
  assert((policy.desiredAccess & 0x20000u)==(acl?0x20000u:0));++tests;
  assert((policy.desiredAccess & (0x2u|0x4u|0x40u|0x10000u|0x40000u|0x80000u))==0);++tests;
  assert(directory?!(policy.desiredAccess&0x1u):!(policy.desiredAccess&0x20u));++tests;
  assert(policy.shareAccess==(directory?0x1u:0x3u));++tests;
 }
 std::cout<<"lease core checks "<<tests<<" passed\n";
}
