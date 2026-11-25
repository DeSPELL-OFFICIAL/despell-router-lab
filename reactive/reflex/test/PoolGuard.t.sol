// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {IPayable} from "@reactive/src/interfaces/IPayable.sol";
import {AbstractPayer} from "@reactive/src/base/AbstractPayer.sol";
import {AbstractCallback} from "@reactive/src/base/AbstractCallback.sol";

import {PoolGuard} from "../src/PoolGuard.sol";

contract PoolGuardTest is Test {
    bytes32 constant POOL = 0xfbce48fa376e45019cf2c5d4afbe45e0fbf19dd3ad442162431aad7519adbbb4;
    bytes32 constant FEE_CHANGED = "fee_changed";
    bytes32 constant ORIGIN_TX = keccak256("fee change tx");

    address proxy = makeAddr("callbackProxy");
    address reflex = makeAddr("poolReflex");
    address owner = makeAddr("owner");
    address stranger = makeAddr("stranger");
    PoolGuard guard;

    function setUp() public {
        guard = new PoolGuard(IPayable(payable(proxy)), reflex, owner);
    }

    function _mark(uint8 status) internal {
        vm.prank(proxy);
        guard.mark(reflex, POOL, status, FEE_CHANGED, 100, ORIGIN_TX);
    }

    // --- who may mark ---

    function test_mark_fromProxyAndReflex_narrowsThePool() public {
        vm.warp(1_795_628_220);
        vm.expectEmit(true, true, false, true, address(guard));
        emit PoolGuard.Marked(POOL, 0, 2, FEE_CHANGED, 100, ORIGIN_TX);
        _mark(guard.NARROWED());

        assertEq(guard.statusOf(POOL), 2);
        PoolGuard.Mark memory m = guard.markOf(POOL);
        assertEq(m.markedAt, 1_795_628_220);
        assertEq(m.originBlock, 100);
        assertEq(m.reason, FEE_CHANGED);
        assertEq(m.originTx, ORIGIN_TX);
    }

    function test_mark_revertsWhenCallerIsNotTheProxy() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(AbstractPayer.NotAuthorized.selector, stranger, proxy));
        guard.mark(reflex, POOL, 2, FEE_CHANGED, 100, ORIGIN_TX);
        assertEq(guard.statusOf(POOL), 0);
    }

    function test_mark_revertsWhenAnotherReactiveContractAsked() public {
        address other = makeAddr("otherReactive");
        vm.prank(proxy);
        vm.expectRevert(abi.encodeWithSelector(AbstractCallback.CallbackNotAuthorized.selector, other, reflex));
        guard.mark(other, POOL, 2, FEE_CHANGED, 100, ORIGIN_TX);
    }

    // --- marks only tighten ---

    function test_mark_neverLoosens() public {
        _mark(guard.BLOCKED());

        vm.expectEmit(true, true, false, true, address(guard));
        emit PoolGuard.MarkKept(POOL, 3, 2, FEE_CHANGED, ORIGIN_TX);
        _mark(guard.NARROWED());
        assertEq(guard.statusOf(POOL), 3);

        _mark(guard.OPEN());
        assertEq(guard.statusOf(POOL), 3);
    }

    function test_mark_sameStatusKeepsTheFirstMark() public {
        _mark(2);
        uint64 firstAt = guard.markOf(POOL).markedAt;
        vm.warp(block.timestamp + 60);
        vm.prank(proxy);
        guard.mark(reflex, POOL, 2, FEE_CHANGED, 200, keccak256("second change"));

        PoolGuard.Mark memory m = guard.markOf(POOL);
        assertEq(m.markedAt, firstAt, "the first mark's time stays");
        assertEq(m.originBlock, 100);
    }

    function test_mark_tightensFromNarrowedToBlocked() public {
        _mark(2);
        _mark(3);
        assertEq(guard.statusOf(POOL), 3);
    }

    function test_mark_unknownStatusFailsClosedAsBlocked() public {
        _mark(7);
        assertEq(guard.statusOf(POOL), 3);
    }

    function test_mark_originBlockSaturatesInsteadOfWrapping() public {
        vm.prank(proxy);
        guard.mark(reflex, POOL, 2, FEE_CHANGED, uint256(type(uint64).max) + 6, ORIGIN_TX);
        assertEq(guard.markOf(POOL).originBlock, type(uint64).max);
    }

    function testFuzz_mark_statusIsTheHighestAskedSoFar(uint8[8] memory asks) public {
        uint8 highest;
        for (uint256 i; i < asks.length; i++) {
            _mark(asks[i]);
            uint8 asked = asks[i] > 3 ? 3 : asks[i];
            if (asked > highest) highest = asked;
            assertEq(guard.statusOf(POOL), highest);
        }
    }

    // --- only the owner reopens ---

    function test_reopen_byOwnerClearsTheMark() public {
        _mark(2);
        vm.expectEmit(true, false, false, true, address(guard));
        emit PoolGuard.Reopened(POOL, 2);
        vm.prank(owner);
        guard.reopen(POOL);

        assertEq(guard.statusOf(POOL), 0);
        assertEq(guard.markOf(POOL).originTx, bytes32(0));
    }

    function test_reopen_revertsForStranger() public {
        _mark(2);
        vm.prank(stranger);
        vm.expectRevert(PoolGuard.NotOwner.selector);
        guard.reopen(POOL);
    }

    function test_reopen_revertsForTheProxyAndReflex() public {
        _mark(2);
        vm.prank(proxy);
        vm.expectRevert(PoolGuard.NotOwner.selector);
        guard.reopen(POOL);
        vm.prank(reflex);
        vm.expectRevert(PoolGuard.NotOwner.selector);
        guard.reopen(POOL);
    }

    function test_reopen_revertsWhenNotMarked() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PoolGuard.NotMarked.selector, POOL));
        guard.reopen(POOL);
    }

    function test_markAfterReopen_narrowsAgain() public {
        _mark(2);
        vm.prank(owner);
        guard.reopen(POOL);
        _mark(2);
        assertEq(guard.statusOf(POOL), 2);
    }

    // --- ownership and setup ---

    function test_ownership_movesInTwoSteps() public {
        address next = makeAddr("server");
        vm.prank(owner);
        guard.transferOwnership(next);
        assertEq(guard.owner(), owner, "not moved until accepted");

        vm.prank(stranger);
        vm.expectRevert(PoolGuard.NotPendingOwner.selector);
        guard.acceptOwnership();

        vm.prank(next);
        guard.acceptOwnership();
        assertEq(guard.owner(), next);
        assertEq(guard.pendingOwner(), address(0));
    }

    function test_constructor_rejectsZeroAddresses() public {
        vm.expectRevert(PoolGuard.ZeroAddress.selector);
        new PoolGuard(IPayable(payable(address(0))), reflex, owner);
        vm.expectRevert(PoolGuard.ZeroAddress.selector);
        new PoolGuard(IPayable(payable(proxy)), address(0), owner);
        vm.expectRevert(PoolGuard.ZeroAddress.selector);
        new PoolGuard(IPayable(payable(proxy)), reflex, address(0));
    }

    function test_constructor_keepsProxyAndReflex() public view {
        assertEq(address(guard._SERVICE_PROVIDER()), proxy);
        assertEq(guard._CALLBACK_SENDER(), reflex);
        assertEq(guard.owner(), owner);
    }

    function test_pay_onlyTheProxyCollectsFees() public {
        vm.deal(address(guard), 1 ether);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(AbstractPayer.NotAuthorized.selector, stranger, proxy));
        guard.pay(1 ether);

        vm.prank(proxy);
        guard.pay(0.001 ether);
        assertEq(proxy.balance, 0.001 ether);
    }
}
