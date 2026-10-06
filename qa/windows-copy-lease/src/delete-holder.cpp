// Generated-fixture actor only. Requests DELETE access but never deletes,
// renames, changes ACLs, or writes file content. Not a copy/containment helper.
#define AVM_GENERATED_EXECUTABLE_NAME L"agentvac-delete-holder-fixture.exe"
#include "../include/lease-native-common.hpp"
namespace {
bool emitHolder(HANDLE out,std::uint8_t phase,Code code,const avm_lease::Nonce& nonce){
 std::array<std::uint8_t,28> bytes{};avm::put32(bytes.data(),24);auto* b=bytes.data()+4;std::copy_n("AVD2",4,b);b[4]=phase;b[5]=static_cast<std::uint8_t>(code);std::copy(nonce.begin(),nonce.end(),b+8);return writeExact(out,bytes.data(),static_cast<DWORD>(bytes.size()));
}
bool releaseAndEof(HANDLE input,const avm_inherited::BoundCaller& caller,const avm_lease::Nonce& nonce,bool& cancelled){
 std::vector<std::uint8_t> bytes;bytes.reserve(28);bool complete=false;
 for(;;){
  if(avm_inherited::detail::alive(caller.process.get())!=avm_inherited::Outcome::Verified)return false;
  DWORD available=0;if(!PeekNamedPipe(input,nullptr,0,nullptr,&available,nullptr))return GetLastError()==ERROR_BROKEN_PIPE&&complete;
  if(!available){Sleep(5);continue;}if(bytes.size()>=28)return false;
  std::array<std::uint8_t,28> chunk{};DWORD count=0;if(!ReadFile(input,chunk.data(),std::min<DWORD>(available,28),&count,nullptr))return GetLastError()==ERROR_BROKEN_PIPE&&complete;
  if(!count)continue;if(count>28-bytes.size())return false;bytes.insert(bytes.end(),chunk.begin(),chunk.begin()+count);
  if(bytes.size()>=4&&avm::u32(bytes.data())!=24)return false;
  if(bytes.size()==28){const auto* b=bytes.data()+4;if(!std::equal(b,b+4,"AVD2")||(b[4]!=2&&b[4]!=3)||b[5]||b[6]||b[7]||!std::equal(b+8,b+24,nonce.begin()))return false;cancelled=b[4]==3;complete=true;}
 }
}
}
int main(int argc,char**){
 SetErrorMode(SEM_FAILCRITICALERRORS|SEM_NOGPFAULTERRORBOX|SEM_NOOPENFILEERRORBOX);
 Handle watchdog(CreateThread(nullptr,0,deadline,nullptr,0,nullptr));if(!watchdog)return 125;
 const HANDLE input=GetStdHandle(STD_INPUT_HANDLE),output=GetStdHandle(STD_OUTPUT_HANDLE);if(argc!=1||GetFileType(input)!=FILE_TYPE_PIPE||GetFileType(output)!=FILE_TYPE_PIPE)return 125;
 avm_lease::Request request;const auto refuse=[&](Code code){return emitHolder(output,3,code,request.nonce)?0:125;};
 try{
  std::array<std::uint8_t,4> header{};if(!readExact(input,header.data(),4))return 125;const auto length=avm::u32(header.data());if(length<42||length>avm_lease::kMaxRequest)return 125;
  std::vector<std::uint8_t> bytes(length);if(!readExact(input,bytes.data(),length)||!std::equal(bytes.begin(),bytes.begin()+4,"AVD2"))return 125;std::copy_n("AVL2",4,bytes.begin());
  if(!avm_lease::parseRequest(bytes,request))return 125;if(!generatedScope(request.inherited))return refuse(kScopeRejected);
  avm_inherited::BoundCaller caller;const auto bound=avm_inherited::bindCaller(input,request.inherited.callerPid,caller);if(bound!=avm_inherited::Outcome::Verified)return refuse(bound==avm_inherited::Outcome::PeerRejected?kCallerRejected:bound==avm_inherited::Outcome::ContextRejected?kContextRejected:Code::MetadataUnavailable);
  TOKEN_STATISTICS own{},peer{};if(!avm_inherited::detail::fixed(caller.currentToken.get(),TokenStatistics,own)||!avm_inherited::detail::fixed(caller.callerToken.get(),TokenStatistics,peer))return refuse(Code::MetadataUnavailable);
  HeldLease held;const auto inspected=inspectLease(request.inherited,caller.userSid(),held);if(inspected.code!=Code::Private||held.paths.empty())return refuse(inspected.code);
  const auto expected=held.paths.back().expected;const auto identity=held.paths.back().initial;held.paths.pop_back();
  // Parents remain pinned. Open only the same derived native device path, with
  // reparse processing disabled, and revalidate the exact original empty inode.
  const auto native=std::wstring(L"\\\\?\\GLOBALROOT")+expected;
  Handle target(CreateFileW(native.c_str(),FILE_READ_ATTRIBUTES|READ_CONTROL|DELETE,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT|FILE_FLAG_BACKUP_SEMANTICS,nullptr));
  if(target.get()==INVALID_HANDLE_VALUE)return refuse(Code::MetadataUnavailable);
  held.paths.push_back({std::move(target),expected,identity,true,false});
  auto value=revalidate(held,caller.userSid());const auto size=(static_cast<std::uint64_t>(value.legacy.nFileSizeHigh)<<32)|value.legacy.nFileSizeLow;
  if(value.code!=Code::Private)return refuse(value.code);if(!avm_lease::initialFile(value.directory,size,value.legacy.nNumberOfLinks))return refuse(Code::IdentityUnavailable);
  if(!contextStable(caller,own,peer))return refuse(kContextRejected);if(!emitHolder(output,1,Code::Private,request.nonce))return 125;
  bool cancelled=false;if(!releaseAndEof(input,caller,request.nonce,cancelled))return refuse(Code::InvalidRequest);if(!contextStable(caller,own,peer))return refuse(kContextRejected);
  value=revalidate(held,caller.userSid());if(value.code!=Code::Private)return refuse(value.code);
  if(value.legacy.nFileSizeHigh||value.legacy.nFileSizeLow||value.legacy.nNumberOfLinks!=1)return refuse(Code::IdentityUnavailable);
  return emitHolder(output,cancelled?4:2,Code::Private,request.nonce)?0:125;
 }catch(...){return refuse(Code::MetadataUnavailable);}
}
