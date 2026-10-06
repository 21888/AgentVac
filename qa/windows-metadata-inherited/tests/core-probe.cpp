#include "../include/core.hpp"
#include <iostream>
#include <sstream>
#include <cassert>
int main() {
  std::string line;
  while (std::getline(std::cin,line)) {
    std::istringstream in(line); char mode=0; in>>mode;
    if (mode=='P') {
      unsigned owner=0,canonical=0,inherit=0,count=0; in>>owner>>canonical>>inherit>>count;
      std::vector<avm::Ace> entries;
      for(unsigned i=0;i<count;++i) {unsigned p=0,k=0,h=0; std::int64_t rights=0; int a=0,b=0; in>>p>>rights>>k>>h>>a>>b; entries.push_back({static_cast<avm::Principal>(p),rights,static_cast<avm::Kind>(k),h!=0,a,b});}
      std::cout << avm::privateAcl(static_cast<avm::Principal>(owner),canonical!=0,entries,inherit!=0) << '\n';
    } else if(mode=='R') {
      std::string hex; in>>hex; std::vector<std::uint8_t> bytes;
      for(std::size_t i=0;i+1<hex.size();i+=2) bytes.push_back(static_cast<std::uint8_t>(std::stoul(hex.substr(i,2),nullptr,16)));
      avm::Request request; std::cout << avm::parse(bytes,request) << '\n';
    } else return 2;
  }
}
