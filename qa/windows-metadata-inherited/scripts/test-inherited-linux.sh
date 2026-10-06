#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")/.."
mkdir -p build results
flags=(-std=c++17 -O1 -g -Wall -Wextra -Werror -Wconversion -Wsign-conversion -fsanitize=address,undefined -fno-omit-frame-pointer)
g++ "${flags[@]}" tests/core.test.cpp -o build/core-tests
g++ "${flags[@]}" tests/inherited-policy.test.cpp -o build/inherited-policy-tests
g++ "${flags[@]}" tests/inherited-request.test.cpp -o build/inherited-request-tests
g++ -std=c++17 -O2 -Wall -Wextra -Werror -Wconversion -Wsign-conversion tests/core-probe.cpp -o build/core-probe
# LeakSanitizer is unavailable under the execution sandbox's ptrace supervision.
ASAN_OPTIONS=detect_leaks=0 ./build/core-tests
ASAN_OPTIONS=detect_leaks=0 ./build/inherited-policy-tests
ASAN_OPTIONS=detect_leaks=0 ./build/inherited-request-tests
node --test tests/differential.test.mjs tests/inherited-protocol.test.mjs tests/research-transport.test.mjs
