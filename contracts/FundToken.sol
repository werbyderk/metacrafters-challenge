// SPDX-License-Identifier: MIT
pragma solidity ^0.8.16;

import "@openzeppelin/contracts/token/ERC20/extensions/draft-ERC20Permit.sol";

contract FundToken is ERC20Permit {
    constructor() ERC20Permit("FundToken") ERC20("FundToken", "FUND") {
        ERC20._mint(msg.sender, 100 ether);
    }
}
