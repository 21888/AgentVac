#include "../include/inherited-request.hpp"
#include <cassert>
#include <iostream>
#include <random>
#include <string>
std::vector<std::uint8_t> packet(const std::string& root,const std::string& target) {
  std::vector<std::uint8_t> body(16+root.size()+target.size());
  body[0]='A';body[1]='V';body[2]='M';body[3]='2';body[5]=1;
  avm::put32(body.data()+8,123);avm::put32(body.data()+12,static_cast<std::uint32_t>(root.size()));
  std::copy(root.begin(),root.end(),body.begin()+16);
  std::copy(target.begin(),target.end(),body.begin()+16+static_cast<std::ptrdiff_t>(root.size()));
  return body;
}
int main(){
  avm_inherited::Request request;const auto valid=packet("C:\\scope","C:\\scope\\target");
  assert(avm_inherited::parseRequest(valid,request)&&request.callerPid==123&&request.target.directory);
  for(auto offset:{3u,4u,5u,6u,7u}){auto v=valid;v[offset]=0xff;assert(!avm_inherited::parseRequest(v,request));}
  auto v=valid;avm::put32(v.data()+8,0);assert(!avm_inherited::parseRequest(v,request));
  for(auto length:{0u,1u,2u,16385u,0xffffffffu}){v=valid;avm::put32(v.data()+12,length);assert(!avm_inherited::parseRequest(v,request));}
  v=valid;v.back()=0xff;assert(!avm_inherited::parseRequest(v,request));
  v=valid;v[4]=1;v[5]=3;assert(!avm_inherited::parseRequest(v,request));
  assert(!avm_inherited::parseRequest(packet("C:\\..","C:\\scope"),request));
  assert(!avm_inherited::parseRequest(packet("C:\\scope","\\\\host\\share"),request));
  std::mt19937 random(0x2026ace);
  for(unsigned n=0;n<50000;++n){std::vector<std::uint8_t> bytes(random()%512);for(auto& b:bytes)b=static_cast<std::uint8_t>(random());if(n%2==0&&bytes.size()>=16){bytes[0]='A';bytes[1]='V';bytes[2]='M';bytes[3]='2';}static_cast<void>(avm_inherited::parseRequest(bytes,request));}
  std::cout<<"inherited request: bounds and 50000 parser fuzz cases passed; nativeWindows=NOT_RUN\n";
}
