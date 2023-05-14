require('@nomicfoundation/hardhat-toolbox')
require('@nomicfoundation/hardhat-network-helpers')
require('@openzeppelin/hardhat-upgrades')
require('solidity-coverage')
require('hardhat-gas-reporter')

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
    solidity: '0.8.17',
    gasReporter: {
        enabled: true,
    },
}
