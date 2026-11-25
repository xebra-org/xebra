// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Test} from "forge-std/Test.sol";
import {ITokenMessengerV2, XebraCctpWrapper} from "../src/XebraCctpWrapper.sol";
import {MockTokenMessengerV2, ReentrantTokenMessengerV2} from "./mocks/MockTokenMessengerV2.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {ShortChangeUSDC} from "./mocks/ShortChangeUSDC.sol";

contract XebraCctpWrapperTest is Test {
    uint32 internal constant ARC = 26;
    uint32 internal constant BASE = 6;
    uint32 internal constant SOLANA = 5;
    uint32 internal constant POLYGON = 7;

    /// The bytes Circle's forwarder has accepted on every forwarded mainnet transfer.
    bytes internal constant PLAIN_HOOK = hex"636374702d666f72776172640000000000000000000000000000000000000000";

    MockUSDC internal usdc;
    MockTokenMessengerV2 internal messenger;
    XebraCctpWrapper internal wrapper;

    address internal admin = makeAddr("admin");
    address internal pauser = makeAddr("pauser");
    address internal feeRecipient = makeAddr("feeRecipient");
    address internal user = makeAddr("user");
    address internal stranger = makeAddr("stranger");

    bytes32 internal evmRecipient = bytes32(uint256(uint160(makeAddr("recipient"))));
    bytes32 internal solanaAccount = keccak256("a Solana USDC token account");
    bytes32 internal solanaOwner = keccak256("the wallet that owns it");

    function params() internal pure returns (XebraCctpWrapper.Params memory) {
        return XebraCctpWrapper.Params({
            feeBps: 10,
            minFee: 300_000,
            minTransfer: 1_000_000,
            maxTransfer: 100_000_000,
            maxFastFeeBps: 5
        });
    }

    function baseCfg() internal pure returns (XebraCctpWrapper.DomainCfg memory) {
        return XebraCctpWrapper.DomainCfg({
            domain: BASE,
            evmStyle: true,
            maxForwardFee: 250_000,
            accountCreation: false,
            maxForwardFeeNewAccount: 0
        });
    }

    function solanaCfg() internal pure returns (XebraCctpWrapper.DomainCfg memory) {
        return XebraCctpWrapper.DomainCfg({
            domain: SOLANA,
            evmStyle: false,
            maxForwardFee: 500_000,
            accountCreation: true,
            maxForwardFeeNewAccount: 1_000_000
        });
    }

    function domains() internal pure returns (XebraCctpWrapper.DomainCfg[] memory list) {
        list = new XebraCctpWrapper.DomainCfg[](2);
        list[0] = baseCfg();
        list[1] = solanaCfg();
    }

    function deploy(IERC20 token, ITokenMessengerV2 tm) internal returns (XebraCctpWrapper) {
        return new XebraCctpWrapper(token, tm, admin, pauser, feeRecipient, params(), domains());
    }

    function setUp() public {
        usdc = new MockUSDC();
        messenger = new MockTokenMessengerV2(ARC);
        wrapper = deploy(IERC20(address(usdc)), ITokenMessengerV2(address(messenger)));
        usdc.mint(user, 1_000_000_000);
        vm.prank(user);
        usdc.approve(address(wrapper), type(uint256).max);
    }

    function req(uint256 amount, uint32 dest, bytes32 recipient, uint256 maxFee)
        internal
        view
        returns (XebraCctpWrapper.BridgeRequest memory)
    {
        return XebraCctpWrapper.BridgeRequest({
            amount: amount,
            destinationDomain: dest,
            mintRecipient: recipient,
            maxFee: maxFee,
            minFinalityThreshold: 2000,
            recipientOwner: bytes32(0),
            maxWrapperFee: type(uint256).max,
            deadline: uint64(block.timestamp + 600)
        });
    }

    function send(XebraCctpWrapper.BridgeRequest memory r) internal returns (XebraCctpWrapper.Quote memory) {
        vm.prank(user);
        return wrapper.bridge(r);
    }

    function expectRevertSend(XebraCctpWrapper.BridgeRequest memory r, bytes4 selector) internal {
        vm.expectRevert(selector);
        vm.prank(user);
        wrapper.bridge(r);
    }

    // ---------------------------------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------------------------------

    function test_bridgeKeepsTheSelectorTheWebEncoderPins() public pure {
        // packages/cctp-evm/src/xebra-wrapper.test.ts asserts the same number.
        assertEq(XebraCctpWrapper.bridge.selector, bytes4(0x132519fe));
    }

    function test_readsItsOwnDomainFromCircle() public view {
        assertEq(wrapper.localDomain(), ARC);
        assertEq(address(wrapper.usdc()), address(usdc));
        assertEq(address(wrapper.tokenMessenger()), address(messenger));
        assertEq(wrapper.getDomains().length, 2);
    }

    function test_refusesItsOwnDomainAsADestination() public {
        XebraCctpWrapper.DomainCfg[] memory list = new XebraCctpWrapper.DomainCfg[](1);
        list[0] = baseCfg();
        list[0].domain = ARC;
        vm.expectRevert(XebraCctpWrapper.SelfDomain.selector);
        new XebraCctpWrapper(IERC20(address(usdc)), ITokenMessengerV2(address(messenger)), admin, pauser, feeRecipient, params(), list);

        XebraCctpWrapper.DomainCfg memory self = baseCfg();
        self.domain = ARC;
        vm.prank(admin);
        vm.expectRevert(XebraCctpWrapper.SelfDomain.selector);
        wrapper.proposeDomain(self);
    }

    function test_refusesAZeroRoleAndADuplicateDomain() public {
        vm.expectRevert(XebraCctpWrapper.ZeroAddress.selector);
        new XebraCctpWrapper(IERC20(address(usdc)), ITokenMessengerV2(address(messenger)), admin, address(0), feeRecipient, params(), domains());

        XebraCctpWrapper.DomainCfg[] memory list = new XebraCctpWrapper.DomainCfg[](2);
        list[0] = baseCfg();
        list[1] = baseCfg();
        vm.expectRevert(XebraCctpWrapper.DomainAlreadyAllowed.selector);
        new XebraCctpWrapper(IERC20(address(usdc)), ITokenMessengerV2(address(messenger)), admin, pauser, feeRecipient, params(), list);
    }

    function test_refusesParamsAboveTheCeilings() public {
        XebraCctpWrapper.Params memory p = params();
        p.feeBps = 101;
        vm.expectRevert(XebraCctpWrapper.FeeBpsTooHigh.selector);
        new XebraCctpWrapper(IERC20(address(usdc)), ITokenMessengerV2(address(messenger)), admin, pauser, feeRecipient, p, domains());

        p = params();
        p.minTransfer = 999_999;
        vm.expectRevert(XebraCctpWrapper.MinTransferTooLow.selector);
        new XebraCctpWrapper(IERC20(address(usdc)), ITokenMessengerV2(address(messenger)), admin, pauser, feeRecipient, p, domains());

        p = params();
        p.maxFastFeeBps = 11;
        vm.expectRevert(XebraCctpWrapper.FastFeeBpsTooHigh.selector);
        new XebraCctpWrapper(IERC20(address(usdc)), ITokenMessengerV2(address(messenger)), admin, pauser, feeRecipient, p, domains());
    }

    // ---------------------------------------------------------------------------------------------
    // The transfer
    // ---------------------------------------------------------------------------------------------

    function test_burnsTheNetToAnEvmChainWithThePlainHook() public {
        // 10 USDC, Circle's fee 0.06: the fee is the 0.30 floor, of which Circle's 0.06 is part.
        XebraCctpWrapper.Quote memory q = send(req(10_000_000, BASE, evmRecipient, 60_000));

        assertEq(q.fee, 300_000);
        assertEq(q.wrapperTake, 240_000);
        assertEq(q.netBurned, 9_760_000);
        assertEq(q.netBurned - q.forwardFee, 9_700_000, "recipient gets amount - fee");

        assertEq(usdc.balanceOf(user), 1_000_000_000 - 10_000_000);
        assertEq(usdc.balanceOf(messenger.MINTER()), 9_760_000);
        assertEq(usdc.balanceOf(address(wrapper)), 240_000);
        assertEq(wrapper.accruedFees(), 240_000);
        assertEq(usdc.allowance(address(wrapper), address(messenger)), 0);
        assertEq(wrapper.seq(), 1);

        MockTokenMessengerV2.Call memory c = messenger.lastCall();
        assertEq(c.amount, 9_760_000);
        assertEq(c.destinationDomain, BASE);
        assertEq(c.mintRecipient, evmRecipient);
        assertEq(c.burnToken, address(usdc));
        assertEq(c.destinationCaller, bytes32(0));
        assertEq(c.maxFee, 60_000);
        assertEq(c.minFinalityThreshold, 2000);
        assertEq(c.hookData, PLAIN_HOOK);
        assertEq(c.sender, address(wrapper));
    }

    function test_acceptsXebrasAttributionSuffixAndBurnsTheSame() public {
        // The web app appends an ERC-8021 suffix ("xebra", length 5, schema 0, marker) to the
        // calldata (packages/sdk/src/core/tag.ts). The ABI decoder reads by offset and ignores it.
        bytes memory data = abi.encodePacked(
            abi.encodeCall(XebraCctpWrapper.bridge, (req(10_000_000, BASE, evmRecipient, 60_000))),
            hex"78656272610500",
            hex"80218021802180218021802180218021"
        );
        vm.prank(user);
        (bool ok, bytes memory ret) = address(wrapper).call(data);
        assertTrue(ok, "a tagged bridge call must not revert");
        XebraCctpWrapper.Quote memory q = abi.decode(ret, (XebraCctpWrapper.Quote));
        assertEq(q.netBurned, 9_760_000);
        assertEq(messenger.lastCall().amount, 9_760_000);
        assertEq(wrapper.seq(), 1);
    }

    function test_announcesTheTransfer() public {
        XebraCctpWrapper.BridgeRequest memory r = req(10_000_000, BASE, evmRecipient, 60_000);
        bytes32 id = keccak256(abi.encode(block.chainid, address(wrapper), uint64(1), user, uint256(9_760_000), BASE, evmRecipient));
        vm.expectEmit(address(wrapper));
        emit XebraCctpWrapper.BridgeInitiated(
            id, 1, user, BASE, evmRecipient, 10_000_000, 300_000, 9_760_000, 60_000, 240_000, 2000, bytes32(0)
        );
        send(r);
    }

    function test_keepsNothingWhenCirclesFeeIsAboveOurs() public {
        // Opening a Solana account costs Circle more than our floor: the sender pays Circle's fee
        // and nothing more, and the whole amount is burned.
        XebraCctpWrapper.BridgeRequest memory r = req(10_000_000, SOLANA, solanaAccount, 450_000);
        r.recipientOwner = solanaOwner;
        XebraCctpWrapper.Quote memory q = send(r);
        assertEq(q.fee, 450_000);
        assertEq(q.wrapperTake, 0);
        assertEq(q.netBurned, 10_000_000);
        assertEq(wrapper.accruedFees(), 0);
        assertEq(usdc.balanceOf(address(wrapper)), 0);
    }

    function test_asksCircleToOpenTheAccountWithTheExact65Bytes() public {
        XebraCctpWrapper.BridgeRequest memory r = req(10_000_000, SOLANA, solanaAccount, 450_000);
        r.recipientOwner = solanaOwner;
        send(r);
        bytes memory expected = bytes.concat(
            hex"636374702d666f7277617264000000000000000000000000", // magic, 24 bytes
            hex"00000000", // version 0
            hex"00000021", // payload length 33
            hex"01", // open the account
            solanaOwner
        );
        assertEq(expected.length, 65);
        assertEq(messenger.lastCall().hookData, expected);
        assertEq(wrapper.forwardHookWithAccount(solanaOwner), expected);
    }

    function test_usesThePlainHookToAnExistingSolanaAccount() public {
        send(req(10_000_000, SOLANA, solanaAccount, 200_000));
        assertEq(messenger.lastCall().hookData, PLAIN_HOOK);
    }

    function test_opensAccountsOnlyWhereThatIsOffered() public {
        XebraCctpWrapper.BridgeRequest memory r = req(10_000_000, BASE, evmRecipient, 60_000);
        r.recipientOwner = solanaOwner;
        expectRevertSend(r, XebraCctpWrapper.RecipientOwnerUnexpected.selector);

        r = req(10_000_000, SOLANA, solanaOwner, 450_000);
        r.recipientOwner = solanaOwner;
        expectRevertSend(r, XebraCctpWrapper.MintRecipientIsOwner.selector);
    }

    function test_holdsEachDeliveryToItsOwnCap() public {
        expectRevertSend(req(10_000_000, BASE, evmRecipient, 250_001), XebraCctpWrapper.ForwardFeeAboveCap.selector);
        expectRevertSend(req(10_000_000, SOLANA, solanaAccount, 500_001), XebraCctpWrapper.ForwardFeeAboveCap.selector);

        XebraCctpWrapper.BridgeRequest memory r = req(20_000_000, SOLANA, solanaAccount, 1_000_001);
        r.recipientOwner = solanaOwner;
        expectRevertSend(r, XebraCctpWrapper.ForwardFeeAboveCap.selector);
        r.maxFee = 1_000_000;
        send(r);
    }

    function test_neverLetsCircleTakeMoreThanATenth() public {
        // 1.5 USDC with Circle's fee at 0.20: the fee is 0.30, 1.40 is burned, and 0.20 is more
        // than a tenth of that.
        expectRevertSend(req(1_500_000, BASE, evmRecipient, 200_000), XebraCctpWrapper.ForwardFeeTooHigh.selector);
    }

    function test_addsTheSpeedFeeAllowanceOnlyForFast() public {
        XebraCctpWrapper.BridgeRequest memory r = req(100_000_000, BASE, evmRecipient, 290_000);
        expectRevertSend(r, XebraCctpWrapper.ForwardFeeAboveCap.selector);
        r.minFinalityThreshold = 1000;
        XebraCctpWrapper.Quote memory q = send(r);
        assertEq(q.forwardFee, 290_000);
        assertEq(messenger.lastCall().minFinalityThreshold, 1000);
    }

    function test_honoursTheSendersOwnFeeCeiling() public {
        XebraCctpWrapper.BridgeRequest memory r = req(10_000_000, BASE, evmRecipient, 60_000);
        r.maxWrapperFee = 299_999;
        expectRevertSend(r, XebraCctpWrapper.WrapperFeeAboveUserCap.selector);
    }

    function test_refusesMalformedRequests() public {
        XebraCctpWrapper.BridgeRequest memory r = req(10_000_000, BASE, evmRecipient, 60_000);
        r.deadline = uint64(block.timestamp);
        expectRevertSend(r, XebraCctpWrapper.RequestExpired.selector);
        r.deadline = uint64(block.timestamp + 3601);
        expectRevertSend(r, XebraCctpWrapper.DeadlineTooFar.selector);

        expectRevertSend(req(10_000_000, POLYGON, evmRecipient, 60_000), XebraCctpWrapper.DomainNotAllowed.selector);
        expectRevertSend(req(10_000_000, ARC, evmRecipient, 60_000), XebraCctpWrapper.DomainNotAllowed.selector);
        expectRevertSend(req(10_000_000, BASE, bytes32(0), 60_000), XebraCctpWrapper.MintRecipientZero.selector);
        // A Solana-shaped value to an EVM chain, and an EVM address to Solana: both mint to
        // something nobody holds.
        expectRevertSend(req(10_000_000, BASE, solanaAccount, 60_000), XebraCctpWrapper.MintRecipientShape.selector);
        expectRevertSend(req(10_000_000, SOLANA, evmRecipient, 200_000), XebraCctpWrapper.MintRecipientShape.selector);

        r = req(10_000_000, BASE, evmRecipient, 60_000);
        r.minFinalityThreshold = 1500;
        expectRevertSend(r, XebraCctpWrapper.BadFinalityThreshold.selector);

        expectRevertSend(req(999_999, BASE, evmRecipient, 60_000), XebraCctpWrapper.AmountBelowMin.selector);
        expectRevertSend(req(100_000_001, BASE, evmRecipient, 60_000), XebraCctpWrapper.AmountAboveMax.selector);
        expectRevertSend(req(10_000_000, BASE, evmRecipient, 0), XebraCctpWrapper.ForwardFeeZero.selector);
    }

    function test_refusesWhilePaused() public {
        vm.prank(pauser);
        wrapper.pause();
        expectRevertSend(req(10_000_000, BASE, evmRecipient, 60_000), XebraCctpWrapper.IsPaused.selector);
    }

    function test_quoteAgreesWithTheTransfer() public {
        XebraCctpWrapper.Quote memory quoted = wrapper.quote(10_000_000, BASE, 60_000, 2000, false);
        XebraCctpWrapper.Quote memory sent = send(req(10_000_000, BASE, evmRecipient, 60_000));
        assertEq(abi.encode(quoted), abi.encode(sent));
    }

    // ---------------------------------------------------------------------------------------------
    // What a misbehaving token or messenger cannot do
    // ---------------------------------------------------------------------------------------------

    function test_failsIfTheMessengerLeavesAllowanceBehind() public {
        messenger.setPullBps(9_999);
        expectRevertSend(req(10_000_000, BASE, evmRecipient, 60_000), XebraCctpWrapper.AllowanceLeft.selector);
    }

    function test_failsIfTheTokenDoesNotArriveWhole() public {
        ShortChangeUSDC short = new ShortChangeUSDC();
        XebraCctpWrapper w = deploy(IERC20(address(short)), ITokenMessengerV2(address(messenger)));
        short.mint(user, 100_000_000);
        vm.startPrank(user);
        short.approve(address(w), type(uint256).max);
        vm.expectRevert(XebraCctpWrapper.AmountNotReceived.selector);
        w.bridge(req(10_000_000, BASE, evmRecipient, 60_000));
        vm.stopPrank();
    }

    function test_cannotBeReenteredFromTheBurn() public {
        ReentrantTokenMessengerV2 evil = new ReentrantTokenMessengerV2(ARC);
        XebraCctpWrapper w = deploy(IERC20(address(usdc)), ITokenMessengerV2(address(evil)));
        XebraCctpWrapper.BridgeRequest memory r = req(10_000_000, BASE, evmRecipient, 60_000);
        evil.arm(address(w), abi.encodeCall(XebraCctpWrapper.bridge, (r)));
        vm.startPrank(user);
        usdc.approve(address(w), type(uint256).max);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        w.bridge(r);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------------------------------------
    // Fees and pausing
    // ---------------------------------------------------------------------------------------------

    function test_paysAccruedFeesToTheRecipientOnly() public {
        send(req(10_000_000, BASE, evmRecipient, 60_000));

        vm.prank(stranger);
        vm.expectRevert(XebraCctpWrapper.NotAuthorized.selector);
        wrapper.withdrawFees(1);

        vm.startPrank(admin);
        vm.expectRevert(XebraCctpWrapper.InsufficientAccruedFees.selector);
        wrapper.withdrawFees(240_001);
        vm.expectRevert(XebraCctpWrapper.AmountNotPositive.selector);
        wrapper.withdrawFees(0);
        wrapper.withdrawFees(240_000);
        vm.stopPrank();

        assertEq(usdc.balanceOf(feeRecipient), 240_000);
        assertEq(wrapper.accruedFees(), 0);
        assertEq(usdc.balanceOf(address(wrapper)), 0);
    }

    function test_pauserStopsButOnlyAdminRestarts() public {
        vm.prank(stranger);
        vm.expectRevert(XebraCctpWrapper.NotAuthorized.selector);
        wrapper.pause();

        vm.prank(pauser);
        wrapper.pause();
        assertTrue(wrapper.paused());

        vm.prank(pauser);
        vm.expectRevert(XebraCctpWrapper.NotAuthorized.selector);
        wrapper.unpause();

        vm.startPrank(admin);
        wrapper.unpause();
        vm.expectRevert(XebraCctpWrapper.NotPaused.selector);
        wrapper.unpause();
        vm.stopPrank();
    }

    // ---------------------------------------------------------------------------------------------
    // Governance
    // ---------------------------------------------------------------------------------------------

    function test_paramsWaitFortyEightHours() public {
        XebraCctpWrapper.Params memory p = params();
        p.feeBps = 20;
        vm.startPrank(admin);
        vm.expectRevert(XebraCctpWrapper.NothingPending.selector);
        wrapper.commitParams();
        wrapper.proposeParams(p);
        vm.expectRevert(XebraCctpWrapper.TimelockNotElapsed.selector);
        wrapper.commitParams();
        vm.warp(block.timestamp + 48 hours);
        wrapper.commitParams();
        vm.stopPrank();
        assertEq(wrapper.getParams().feeBps, 20);
        assertEq(wrapper.pendingParams().eta, 0);
    }

    function test_paramsTightenAtOnceButNeverLoosen() public {
        XebraCctpWrapper.Params memory p = params();
        p.maxTransfer = 50_000_000;
        vm.prank(admin);
        wrapper.tightenParams(p);
        assertEq(wrapper.getParams().maxTransfer, 50_000_000);

        p.feeBps = 11;
        vm.prank(admin);
        vm.expectRevert(XebraCctpWrapper.NotTightening.selector);
        wrapper.tightenParams(p);

        vm.prank(pauser);
        vm.expectRevert(XebraCctpWrapper.NotAuthorized.selector);
        wrapper.tightenParams(params());
    }

    function test_newAdminMustAcceptAfterTheTimelock() public {
        address next = makeAddr("next admin");
        vm.prank(admin);
        wrapper.proposeAdmin(next);

        vm.prank(stranger);
        vm.expectRevert(XebraCctpWrapper.NotAuthorized.selector);
        wrapper.acceptAdmin();

        vm.prank(next);
        vm.expectRevert(XebraCctpWrapper.TimelockNotElapsed.selector);
        wrapper.acceptAdmin();

        vm.warp(block.timestamp + 48 hours);
        vm.prank(next);
        wrapper.acceptAdmin();
        assertEq(wrapper.admin(), next);
    }

    function test_pauserAndFeeRecipientChangesWait() public {
        address p2 = makeAddr("pauser 2");
        address r2 = makeAddr("recipient 2");
        vm.startPrank(admin);
        wrapper.proposePauser(p2);
        wrapper.proposeFeeRecipient(r2);
        vm.expectRevert(XebraCctpWrapper.TimelockNotElapsed.selector);
        wrapper.commitPauser();
        vm.expectRevert(XebraCctpWrapper.TimelockNotElapsed.selector);
        wrapper.commitFeeRecipient();
        vm.warp(block.timestamp + 48 hours);
        wrapper.commitPauser();
        wrapper.commitFeeRecipient();
        vm.stopPrank();
        assertEq(wrapper.pauser(), p2);
        assertEq(wrapper.feeRecipient(), r2);
    }

    function test_pauserCanVetoEveryPendingChange() public {
        XebraCctpWrapper.DomainCfg memory polygon = baseCfg();
        polygon.domain = POLYGON;
        vm.startPrank(admin);
        wrapper.proposeParams(params());
        wrapper.proposeAdmin(stranger);
        wrapper.proposePauser(stranger);
        wrapper.proposeFeeRecipient(stranger);
        wrapper.proposeDomain(polygon);
        vm.stopPrank();

        vm.prank(pauser);
        wrapper.cancelPending();
        vm.warp(block.timestamp + 48 hours);

        vm.startPrank(admin);
        vm.expectRevert(XebraCctpWrapper.NothingPending.selector);
        wrapper.commitParams();
        vm.expectRevert(XebraCctpWrapper.NothingPending.selector);
        wrapper.commitPauser();
        vm.expectRevert(XebraCctpWrapper.NothingPending.selector);
        wrapper.commitFeeRecipient();
        vm.expectRevert(XebraCctpWrapper.NothingPending.selector);
        wrapper.commitDomain();
        vm.stopPrank();
        vm.prank(stranger);
        vm.expectRevert(XebraCctpWrapper.NothingPending.selector);
        wrapper.acceptAdmin();
    }

    function test_addsAndReplacesADomainAfterTheTimelock() public {
        // Absolute times: under via-ir a second `block.timestamp + …` can read the first warp's
        // starting point again.
        uint256 t0 = block.timestamp;
        XebraCctpWrapper.DomainCfg memory polygon = baseCfg();
        polygon.domain = POLYGON;
        vm.startPrank(admin);
        wrapper.proposeDomain(polygon);
        vm.expectRevert(XebraCctpWrapper.TimelockNotElapsed.selector);
        wrapper.commitDomain();
        vm.warp(t0 + 48 hours);
        wrapper.commitDomain();
        assertEq(wrapper.getDomains().length, 3);

        vm.expectRevert(XebraCctpWrapper.DomainAlreadyAllowed.selector);
        wrapper.proposeDomain(polygon);

        polygon.maxForwardFee = 400_000;
        wrapper.proposeDomain(polygon);
        vm.warp(t0 + 96 hours);
        wrapper.commitDomain();
        vm.stopPrank();
        (bool allowed, XebraCctpWrapper.DomainCfg memory cfg) = wrapper.getDomain(POLYGON);
        assertTrue(allowed);
        assertEq(cfg.maxForwardFee, 400_000);
        assertEq(wrapper.getDomains().length, 3);
    }

    function test_refusesDomainsThatCouldNeverWork() public {
        XebraCctpWrapper.DomainCfg memory cfg = baseCfg();
        cfg.accountCreation = true;
        cfg.maxForwardFeeNewAccount = 1;
        vm.startPrank(admin);
        vm.expectRevert(XebraCctpWrapper.BadForwardConfig.selector);
        wrapper.proposeDomain(cfg);

        cfg = baseCfg();
        cfg.maxForwardFee = 0;
        vm.expectRevert(XebraCctpWrapper.BadForwardConfig.selector);
        wrapper.proposeDomain(cfg);

        cfg.maxForwardFee = 2_000_001;
        vm.expectRevert(XebraCctpWrapper.BadForwardConfig.selector);
        wrapper.proposeDomain(cfg);

        cfg = baseCfg();
        cfg.maxForwardFeeNewAccount = 1;
        vm.expectRevert(XebraCctpWrapper.BadForwardConfig.selector);
        wrapper.proposeDomain(cfg);
        vm.stopPrank();
    }

    function test_pauserTightensAndRemovesDomainsAtOnce() public {
        vm.startPrank(pauser);
        wrapper.tightenDomain(SOLANA, 400_000, false, 999);
        (, XebraCctpWrapper.DomainCfg memory cfg) = wrapper.getDomain(SOLANA);
        assertEq(cfg.maxForwardFee, 400_000);
        assertFalse(cfg.accountCreation);
        assertEq(cfg.maxForwardFeeNewAccount, 0, "a switched-off creation keeps no cap");

        vm.expectRevert(XebraCctpWrapper.NotTightening.selector);
        wrapper.tightenDomain(SOLANA, 400_001, false, 0);
        vm.expectRevert(XebraCctpWrapper.NotTightening.selector);
        wrapper.tightenDomain(SOLANA, 400_000, true, 1);
        vm.expectRevert(XebraCctpWrapper.NotTightening.selector);
        wrapper.tightenDomain(SOLANA, 400_000, false, 0);

        wrapper.removeDomain(BASE);
        vm.stopPrank();

        XebraCctpWrapper.DomainCfg[] memory left = wrapper.getDomains();
        assertEq(left.length, 1);
        assertEq(left[0].domain, SOLANA);
        expectRevertSend(req(10_000_000, BASE, evmRecipient, 60_000), XebraCctpWrapper.DomainNotAllowed.selector);

        vm.prank(stranger);
        vm.expectRevert(XebraCctpWrapper.NotAuthorized.selector);
        wrapper.removeDomain(SOLANA);
    }

    function test_onlyTheAdminProposes() public {
        vm.startPrank(pauser);
        vm.expectRevert(XebraCctpWrapper.NotAuthorized.selector);
        wrapper.proposeParams(params());
        vm.expectRevert(XebraCctpWrapper.NotAuthorized.selector);
        wrapper.proposeDomain(baseCfg());
        vm.expectRevert(XebraCctpWrapper.NotAuthorized.selector);
        wrapper.proposeAdmin(pauser);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------------------------------------
    // Properties
    // ---------------------------------------------------------------------------------------------

    function testFuzz_theSplitAlwaysAddsUp(uint256 amount, uint16 feeBps, uint256 minFee, uint256 maxFee) public view {
        amount = bound(amount, 1, wrapper.MAX_TRANSFER_CEILING());
        feeBps = uint16(bound(feeBps, 0, wrapper.MAX_FEE_BPS_CEILING()));
        minFee = bound(minFee, 0, wrapper.MAX_MIN_FEE_CEILING());
        maxFee = bound(maxFee, 1, wrapper.MAX_FORWARD_FEE_CEILING());
        try wrapper.computeSplit(amount, feeBps, minFee, maxFee) returns (XebraCctpWrapper.Quote memory q) {
            uint256 pct = amount * feeBps / 10_000;
            uint256 base = pct > minFee ? pct : minFee;
            assertEq(q.wrapperTake + q.netBurned, amount, "nothing created or lost");
            assertEq(q.fee, q.wrapperTake + q.forwardFee, "Circle's fee is inside ours");
            assertEq(q.netBurned - q.forwardFee, amount - q.fee, "recipient gets amount - fee");
            assertGe(q.fee, base);
            assertGe(q.fee, maxFee);
            assertGt(q.netBurned, q.forwardFee);
        } catch {
            // Refused only when the recipient would get nothing.
            uint256 pct = amount * feeBps / 10_000;
            uint256 base = pct > minFee ? pct : minFee;
            uint256 fee = base > maxFee ? base : maxFee;
            assertGe(fee, amount);
        }
    }

    function testFuzz_holdsOnlyWhatItIsOwed(uint256 a1, uint256 a2, uint256 m1, uint256 m2) public {
        a1 = bound(a1, 5_000_000, 100_000_000);
        a2 = bound(a2, 5_000_000, 100_000_000);
        m1 = bound(m1, 1, 250_000);
        m2 = bound(m2, 1, 250_000);
        send(req(a1, BASE, evmRecipient, m1));
        send(req(a2, BASE, evmRecipient, m2));
        assertEq(usdc.balanceOf(address(wrapper)), wrapper.accruedFees());
        assertEq(usdc.allowance(address(wrapper), address(messenger)), 0);
        // Our floor is above every fee allowed here, so both transfers left something to collect.
        uint256 owed = wrapper.accruedFees();
        assertGt(owed, 0);
        vm.prank(admin);
        wrapper.withdrawFees(owed);
        assertEq(usdc.balanceOf(address(wrapper)), 0);
        assertEq(usdc.balanceOf(feeRecipient), owed);
    }
}
