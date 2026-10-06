#include "../include/core.hpp"
#include <cassert>
#include <iostream>
#include <random>
int main() {
  using namespace avm;
  std::u16string value=u"c:/valid/child/"; assert(canonicalize(value)&&value==u"C:\\valid\\child");
  for(auto bad:{u"C:\\\\",u"C:\\..",u"C:\\a\\\\b",u"C:\\COM\u00b9.txt",u"C:\\x.",u"C:\\x ",u"C:\\x:stream",u"//?/C:/x",u"\\\\server\\x",u"\\\\?\\C:/x",u"C:relative",u"C:\\NUL.txt"}) {value=bad; assert(!canonicalize(value));}
  value=u"C:\\"; assert(canonicalize(value));
  value=u"\\\\?\\c:\\a"; assert(canonicalize(value)&&value==u"C:\\a");
  value=u"C:\\"; value.push_back(0xd800); assert(!canonicalize(value));
  assert(nativeMapping(u"\\Device\\HarddiskVolume12"));
  for(auto mapping:{u"\\??\\C:\\alias",u"\\Device\\Mup\\host",u"\\Device\\HarddiskVolume2\\child",u"\\Device\\HarddiskVolume"}) assert(!nativeMapping(mapping));
  assert(sidShape(1,1) && sidShape(1,14));
  assert(!sidShape(1,0) && !sidShape(1,15) && !sidShape(2,1));
  const Ace current{Principal::Current,3,Kind::Allow,false,3,0};
  assert(privateAcl(Principal::Current,true,{current},true));
  assert(!privateAcl(Principal::Other,true,{current},true));
  assert(!privateAcl(Principal::Current,false,{current},true));
  assert(privateAcl(Principal::System,true,{{Principal::Other,1,Kind::Deny,false,0,0},current},true));
  assert(!privateAcl(Principal::System,true,{{Principal::Current,1,Kind::Deny,false,0,0},current},true));
  assert(canonicalAcl({{Principal::Other,1,Kind::Deny,false,0,0},current}));
  assert(!canonicalAcl({current,{Principal::Other,1,Kind::Deny,false,0,0}}));
  assert(canonicalAcl({current,{Principal::Other,1,Kind::Deny,true,0,0}}));
  assert(!canonicalAcl({{Principal::Current,3,Kind::Allow,true,3,0},current}));
  assert(!privateAcl(Principal::Current,true,std::vector<Ace>(129,current),true));
  std::mt19937 random(0xace2026); Request request;
  for(unsigned n=0;n<50000;++n) {
    std::vector<std::uint8_t> bytes(random()%256);
    for(auto& b:bytes)b=static_cast<std::uint8_t>(random());
    if(n%2==0&&bytes.size()>=8){bytes[0]='A';bytes[1]='V';bytes[2]='M';bytes[3]='1';bytes[4]=static_cast<std::uint8_t>(random()%3);bytes[5]=static_cast<std::uint8_t>(random()%5);bytes[6]=bytes[7]=0;}
    static_cast<void>(parse(bytes,request));
  }
  std::cout<<"pure core tests and 50000 bounded parser fuzz cases passed; nativeWindows=NOT_RUN\n";
}
