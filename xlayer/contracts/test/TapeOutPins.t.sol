// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {TapeOutPins} from "../src/TapeOut.sol";

/// The Solidity packing the tape-out script uses for `eval` equals the TypeScript packing (src/bits.ts `packPins`),
/// whose output the samples file records for every sample vector.
contract TapeOutPinsTest is Test {
    function test_packEqualsTheSamplesFile() public view {
        string memory json = vm.readFile("../circuit/pool-judgment-samples.json");
        uint256 pins = vm.parseJsonUint(json, ".nIn");
        uint256[] memory vectors = vm.parseJsonUintArray(json, ".vectors");
        bytes[] memory inputs = vm.parseJsonBytesArray(json, ".inputs");
        assertEq(vectors.length, inputs.length);
        assertGt(vectors.length, 0);
        for (uint256 i = 0; i < vectors.length; i++) {
            assertEq(TapeOutPins.pack(vectors[i], pins), inputs[i]);
        }
    }

    function test_packSetsOneBitPerPin() public pure {
        assertEq(TapeOutPins.pack(0, 27), hex"00000000");
        assertEq(TapeOutPins.pack(1, 27), hex"01000000");
        assertEq(TapeOutPins.pack(1 << 8, 27), hex"00010000");
        assertEq(TapeOutPins.pack(1 << 26, 27), hex"00000004");
        assertEq(TapeOutPins.pack((1 << 27) - 1, 27), hex"ffffff07");
    }
}
