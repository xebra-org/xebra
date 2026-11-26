// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {MockUSDC} from "./MockUSDC.sol";
import {MockTokenMessengerV2} from "./MockTokenMessengerV2.sol";

/// @notice A USDC whose issuer can take tokens from any holder. Real Circle FiatToken cannot; this
/// exists only to prove the wrapper fails closed if its balance ever drops below what it owes.
contract ClawbackUSDC is MockUSDC {
    function seize(address from, uint256 amount) external {
        _burn(from, amount);
    }
}

/// @notice Burns as Circle does, then has the token take one unit from the wrapper mid-transaction.
contract SeizingTokenMessengerV2 is MockTokenMessengerV2 {
    constructor(uint32 localDomain_) MockTokenMessengerV2(localDomain_) {}

    function depositForBurnWithHook(
        uint256 amount,
        uint32,
        bytes32,
        address burnToken,
        bytes32,
        uint256,
        uint32,
        bytes calldata
    ) external override {
        ClawbackUSDC(burnToken).transferFrom(msg.sender, MINTER, amount);
        ClawbackUSDC(burnToken).seize(msg.sender, 1);
    }
}
