#include "../include/lease-native-common.hpp"
namespace {
bool emitLease(HANDLE output,avm_lease::Phase phase,const avm_lease::Nonce& nonce,const Observation& value){
 avm_lease::Identity identity;
 identity.volume32=value.legacy.dwVolumeSerialNumber;
 identity.fileIndex64=(static_cast<std::uint64_t>(value.legacy.nFileIndexHigh)<<32)|value.legacy.nFileIndexLow;
 identity.size=(static_cast<std::uint64_t>(value.legacy.nFileSizeHigh)<<32)|value.legacy.nFileSizeLow;
 identity.links=value.legacy.nNumberOfLinks;identity.attributes=value.legacy.dwFileAttributes;identity.volume64=value.identity.VolumeSerialNumber;
 std::copy_n(value.identity.FileId.Identifier,16,identity.fileId128.begin());
 avm_lease::Reply bytes{};
 if(!avm_lease::makeReply(phase,nonce,value.code,value.code==Code::Private&&value.exists?&identity:nullptr,bytes,value.reason))return false;
 return writeExact(output,bytes.data(),static_cast<DWORD>(bytes.size()));
}

bool readControlAndEof(HANDLE input,const avm_inherited::BoundCaller& caller,const avm_lease::Nonce& nonce,avm_lease::Control& control){
 std::vector<std::uint8_t> bytes;bytes.reserve(4+avm_lease::kControlBytes);bool parsed=false;
 for(;;){
  if(avm_inherited::detail::alive(caller.process.get())!=avm_inherited::Outcome::Verified)return false;
  DWORD available=0;if(!PeekNamedPipe(input,nullptr,0,nullptr,&available,nullptr))return GetLastError()==ERROR_BROKEN_PIPE&&parsed;
  if(!available){Sleep(5);continue;}
  if(bytes.size()>=4+avm_lease::kControlBytes)return false;
  std::array<std::uint8_t,28> chunk{};DWORD count=0;const DWORD want=std::min<DWORD>(available,static_cast<DWORD>(chunk.size()));
  if(!ReadFile(input,chunk.data(),want,&count,nullptr)){return GetLastError()==ERROR_BROKEN_PIPE&&parsed;}
  if(!count)continue; // A null pipe write is not EOF.
  if(count>4+avm_lease::kControlBytes-bytes.size())return false;
  bytes.insert(bytes.end(),chunk.begin(),chunk.begin()+count);
  if(bytes.size()>=4&&avm::u32(bytes.data())!=avm_lease::kControlBytes)return false;
  if(bytes.size()==4+avm_lease::kControlBytes){const std::vector<std::uint8_t> body(bytes.begin()+4,bytes.end());if(!avm_lease::parseControl(body,nonce,control))return false;parsed=true;}
 }
}
}
int main(int argc,char**){
 SetErrorMode(SEM_FAILCRITICALERRORS|SEM_NOGPFAULTERRORBOX|SEM_NOOPENFILEERRORBOX);
 Handle watchdog(CreateThread(nullptr,0,deadline,nullptr,0,nullptr));if(!watchdog)return 125;
 const HANDLE input=GetStdHandle(STD_INPUT_HANDLE),output=GetStdHandle(STD_OUTPUT_HANDLE);
 if(argc!=1||GetFileType(input)!=FILE_TYPE_PIPE||GetFileType(output)!=FILE_TYPE_PIPE)return 125;
 avm_lease::Request request;Observation result;result.code=Code::InvalidRequest;
 const auto refuse=[&](){return emitLease(output,avm_lease::Phase::Refused,request.nonce,result)?0:125;};
 try{
  std::array<std::uint8_t,4> header{};if(!readExact(input,header.data(),4))return refuse();const auto length=avm::u32(header.data());
  if(length<42||length>avm_lease::kMaxRequest)return refuse();std::vector<std::uint8_t> bytes(length);
  if(!readExact(input,bytes.data(),length)||!avm_lease::parseRequest(bytes,request))return refuse();
  if(!generatedScope(request.inherited)){result.code=kScopeRejected;return refuse();}
  avm_inherited::BoundCaller caller;const auto bound=avm_inherited::bindCaller(input,request.inherited.callerPid,caller);
  if(bound!=avm_inherited::Outcome::Verified){result.code=bound==avm_inherited::Outcome::PeerRejected?kCallerRejected:bound==avm_inherited::Outcome::ContextRejected?kContextRejected:Code::MetadataUnavailable;return refuse();}
  TOKEN_STATISTICS own{},peer{};if(!avm_inherited::detail::fixed(caller.currentToken.get(),TokenStatistics,own)||!avm_inherited::detail::fixed(caller.callerToken.get(),TokenStatistics,peer)){result.code=Code::MetadataUnavailable;return refuse();}
  HeldLease held;result=inspectLease(request.inherited,caller.userSid(),held);
  if(result.code!=Code::Private)return refuse();if(!contextStable(caller,own,peer)){result={};result.code=kContextRejected;return refuse();}
  if(!emitLease(output,avm_lease::Phase::Ready,request.nonce,result))return 125;
  avm_lease::Control control=avm_lease::Control::Cancel;
  if(!readControlAndEof(input,caller,request.nonce,control)){result={};result.code=Code::InvalidRequest;return refuse();}
  if(!contextStable(caller,own,peer)){result={};result.code=kContextRejected;return refuse();}
  result=revalidate(held,caller.userSid());if(result.code!=Code::Private)return refuse();
  return emitLease(output,control==avm_lease::Control::Release?avm_lease::Phase::Released:avm_lease::Phase::Cancelled,request.nonce,result)?0:125;
 }catch(...){result={};result.code=Code::MetadataUnavailable;return refuse();}
}
