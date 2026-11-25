// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {IERC20} from "forge-std/interfaces/IERC20.sol";
import {TapeOutScript} from "../script/TapeOut.s.sol";
import {ITapeOutFactory, TapeOutAddresses} from "../src/TapeOut.sol";

/// The tape-out script on a fork of X Layer mainnet, from a test wallet. Nothing is sent to the chain.
/// Run: FOUNDRY_PROFILE=fork forge test -vv
contract TapeOutForkTest is Test {
    /// A throwaway test key; its address only ever holds funds on the fork.
    uint256 internal constant KEY = 0xA11CE;
    IERC20 internal constant BEM = IERC20(TapeOutAddresses.BEM);
    ITapeOutFactory internal constant FACTORY = ITapeOutFactory(TapeOutAddresses.FACTORY);

    address internal wallet;
    TapeOutScript internal script;

    function setUp() public {
        vm.createSelectFork("xlayer");
        wallet = vm.addr(KEY);
        vm.setEnv("PRIVATE_KEY", vm.toString(KEY));
        script = new TapeOutScript();
    }

    /// Create, then tape out; each step run twice. The second runs must not spend anything.
    function test_createAndTapeOutTwice() public {
        vm.deal(wallet, 0.003 ether);
        deal(address(BEM), wallet, 0.12e8);
        uint256 processors = FACTORY.cpuCount();

        script.createProcessor();
        script.createProcessor();
        assertEq(FACTORY.cpuCount(), processors + 1, "one processor only");
        uint256 bemAfterCreate = BEM.balanceOf(wallet);

        script.tapeOutCircuit();
        uint256 okb = wallet.balance;
        uint256 bem = BEM.balanceOf(wallet);
        script.tapeOutCircuit();
        assertEq(wallet.balance, okb, "second tape-out run spends no OKB");
        assertEq(BEM.balanceOf(wallet), bem, "second tape-out run spends no BEM");
        script.status();

        console.log("BEM spent creating / minting (1e-8):", 0.12e8 - bemAfterCreate, bemAfterCreate - bem);
        console.log("OKB spent taping out (wei):", 0.003 ether - okb);
    }

    /// The whole run from OKB only: swap through a real LI.FI quote, create, tape out. Needs quote/bem-swap.json
    /// fetched for this test wallet: node ../scripts/quote-bem.ts --wallet <address of KEY> (skipped without it).
    function test_swapCreateTapeOutFromOkbOnly() public {
        if (!vm.exists("quote/bem-swap.json")) {
            console.log("no quote/bem-swap.json: fetch one for", wallet);
            vm.skip(true);
        }
        vm.deal(wallet, 0.03 ether);
        assertEq(BEM.balanceOf(wallet), 0);

        script.swapForBem();
        uint256 bemAfterSwap = BEM.balanceOf(wallet);
        script.swapForBem();
        assertEq(BEM.balanceOf(wallet), bemAfterSwap, "second swap run does nothing");
        script.createProcessor();
        script.tapeOutCircuit();

        console.log("BEM from the swap / left (1e-8):", bemAfterSwap, BEM.balanceOf(wallet));
        console.log("OKB spent in all (wei, fees and swap; no gas on a fork):", 0.03 ether - wallet.balance);
    }
}
