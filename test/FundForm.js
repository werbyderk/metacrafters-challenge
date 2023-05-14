const { ethers, upgrades } = require('hardhat')
const { expect } = require('chai')
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers')

const FIFTEEN_DAYS = 60 * 60 * 24 * 15
const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'

const signERC20Permit = async (signer, spender, value, token, send = false) => {
    const deadline = Math.round(Date.now() / 1000) * 1000
    const sig = await signer._signTypedData(
        {
            name: 'FundToken',
            version: '1',
            chainId: parseInt(await ethers.provider.send('eth_chainId', []), 16).toString(),
            verifyingContract: token.address,
        },
        {
            Permit: [
                { name: 'owner', type: 'address' },
                { name: 'spender', type: 'address' },
                { name: 'value', type: 'uint256' },
                { name: 'nonce', type: 'uint256' },
                { name: 'deadline', type: 'uint256' },
            ],
        },
        {
            owner: signer.address,
            spender: spender.address,
            value: value.toString(),
            nonce: (await token.nonces(signer.address)).toString(),
            deadline: deadline.toString(),
        }
    )
    const { v, r, s } = ethers.utils.splitSignature(sig)
    if (send)
        await token
            .connect(signer)
            .permit(signer.address, spender.address, value, deadline, v, r, s)
    return { deadline, v, r, s }
}

const getSigners = async () => {
    const [deployer, usr0, usr1, usr2] = await ethers.getSigners()
    return { deployer, usr0, usr1, usr2 }
}

const deployFundToken = async () => {
    const FundToken = await ethers.getContractFactory('FundToken')
    const fundToken = await FundToken.deploy()
    await fundToken.deployed()

    const signers = await getSigners()
    const tenTokens = ethers.utils.parseEther('10')
    await fundToken.transfer(signers.usr0.address, tenTokens)
    await fundToken.transfer(signers.usr1.address, tenTokens)
    await fundToken.transfer(signers.usr2.address, tenTokens)

    return fundToken
}

const deployV1 = async () => {
    const fundToken = await deployFundToken()
    const FundForm = await ethers.getContractFactory('FundForm')
    const fundForm = await upgrades.deployProxy(FundForm, [fundToken.address], { kind: 'uups' })
    return { ...(await getSigners()), fundForm, fundToken }
}

const deployV2 = async () => {
    const fixture = await deployV1()
    const FundFormV2 = await ethers.getContractFactory('FundFormV2')
    const fundForm = await upgrades.upgradeProxy(fixture.fundForm, FundFormV2, { kind: 'uups' })
    return { ...fixture, fundForm }
}

const deployV1ActiveCampaign = async () => {
    const { fundForm, ...other } = await loadFixture(deployV1)
    const deadline = Math.round(Date.now() / 1000 + FIFTEEN_DAYS)
    const goal = ethers.utils.parseEther('5')
    await fundForm.createCampaign(goal, deadline)
    return { ...other, fundForm, deadline, goal }
}

const deployV1CompletedCampaign = async () => {
    const fixture = await loadFixture(deployV1ActiveCampaign)
    const { fundForm, fundToken, usr0, goal } = fixture

    const { deadline, v, r, s } = await signERC20Permit(usr0, fundForm, goal, fundToken)
    await fundForm.connect(usr0).pledge(0, goal, deadline, v, r, s)
    await ethers.provider.send('evm_increaseTime', [FIFTEEN_DAYS + 1])
    await ethers.provider.send('evm_mine', [])
    return fixture
}

describe('Fund Form', () => {
    describe('Deployment', () => {
        it('Deploys', async () => {
            const { fundForm } = await loadFixture(deployV1)
            expect(fundForm.address).to.not.equal(ethers.constants.AddressZero)
        })

        it('Initialize from implementation', async () => {
            const { fundForm, fundToken } = await loadFixture(deployV1)
            const implementationAddressRaw = await ethers.provider.getStorageAt(
                fundForm.address,
                IMPLEMENTATION_SLOT
            )
            const [implementationAddress] = ethers.utils.defaultAbiCoder.decode(
                ['address'],
                implementationAddressRaw
            )
            const fundFormImp = new ethers.Contract(
                implementationAddress,
                fundForm.interface,
                await ethers.getSigner()
            )

            await expect(fundFormImp.initialize(fundToken.address)).to.be.rejectedWith(
                'Function must be called through delegatecall'
            )
        })

        it('Upgrades', async () => {
            const { fundForm } = await loadFixture(deployV1)
            const getImplementation = () =>
                ethers.provider.getStorageAt(fundForm.address, IMPLEMENTATION_SLOT)
            const oldAddr = await getImplementation()
            const FundFromV2 = await ethers.getContractFactory('FundFormV2')
            await upgrades.upgradeProxy(fundForm.address, FundFromV2, { kind: 'uups' })
            const newAddr = await getImplementation()
            expect(oldAddr).to.not.equal(newAddr).to.not.equal(ethers.constants.AddressZero)
        })

        it('Upgrades - only owner', async () => {
            const { fundForm, usr0 } = await loadFixture(deployV1)
            const FundFromV2 = await ethers.getContractFactory('FundFormV2')
            // hh-upgrades does not allow specifying a signer, doing this manually
            const fundFormV2 = await FundFromV2.deploy()
            await fundFormV2.deployed()
            await expect(fundForm.connect(usr0).upgradeTo(fundFormV2.address)).to.be.rejectedWith(
                'Ownable: caller is not the owner'
            )
            await fundForm.upgradeTo(fundFormV2.address)
        })
    })

    describe('Campaigns', () => {
        it('Create campaign', async () => {
            const { deadline, goal, fundForm, deployer } = await loadFixture(deployV1ActiveCampaign)
            const campaign = await fundForm.campaigns(0)
            expect(campaign.deadline).to.be.approximately(deadline, 1)
            expect(campaign.goal).to.equal(goal)
            expect(campaign.creator).to.equal(deployer.address)
        })

        it('Create campaign - invalid deadline', async () => {
            const { fundForm } = await loadFixture(deployV1)
            const goal = ethers.utils.parseEther('5')
            const deadline = 0
            await expect(fundForm.createCampaign(goal, deadline)).to.be.rejectedWith(
                'Invalid deadline.'
            )
        })

        it('Create campaign - invalid goal', async () => {
            const { fundForm } = await loadFixture(deployV1)
            const goal = 0
            const deadline = Math.round(Date.now() / 1000) + FIFTEEN_DAYS
            await expect(fundForm.createCampaign(goal, deadline)).to.be.rejectedWith(
                'Invalid goal.'
            )
        })

        it('Create campaign - multiple', async () => {
            const { deadline, fundForm } = await loadFixture(deployV1ActiveCampaign)
            const secondCampaignGoal = ethers.utils.parseEther('3')
            await fundForm.createCampaign(secondCampaignGoal, deadline)
            expect((await fundForm.campaigns(1)).goal).to.equal(secondCampaignGoal)
        })

        it('Create campaign - emmitted event', async () => {
            const { fundForm, deployer } = await loadFixture(deployV1)
            const goal = ethers.utils.parseEther('5')
            const deadline = Math.round(Date.now() / 1000) + FIFTEEN_DAYS
            const tx = await fundForm.createCampaign(goal, deadline)
            const receipt = await tx.wait()

            const { topics } = receipt.events[0]
            const [addrTopic] = ethers.utils.defaultAbiCoder.decode(['address'], topics[1])
            const [indxTopic] = ethers.utils.defaultAbiCoder.decode(['uint256'], topics[2])

            expect(addrTopic).to.equal(deployer.address)
            expect(indxTopic).to.equal(0)
        })

        it('Withdraw funds - completed campaign', async () => {
            const { fundToken, fundForm, deployer, goal } = await loadFixture(
                deployV1CompletedCampaign
            )
            await expect(fundForm.withdrawFunds(0)).to.changeTokenBalance(
                fundToken,
                deployer.address,
                goal
            )
        })

        it('Withdraw funds - active campaign', async () => {
            const { fundForm } = await loadFixture(deployV1ActiveCampaign)

            await expect(fundForm.withdrawFunds(0)).to.be.rejectedWith('This campaign is active.')
        })

        it('Withdraw funds - unauthorized', async () => {
            const { fundForm, usr0 } = await loadFixture(deployV1CompletedCampaign)

            await expect(fundForm.connect(usr0).withdrawFunds(0)).to.be.rejectedWith('Unauthorized')
        })

        it('Withdraw funds - twice', async () => {
            const { fundForm } = await loadFixture(deployV1CompletedCampaign)

            await fundForm.withdrawFunds(0)
            await expect(fundForm.withdrawFunds(0)).to.be.rejectedWith('This campaign is archived.')
        })

        it('Withdraw funds - goal not met', async () => {
            const { fundToken, fundForm, usr0 } = await loadFixture(deployV1ActiveCampaign)

            const pledgeAmount = ethers.utils.parseEther('1')
            const { deadline, v, r, s } = await signERC20Permit(
                usr0,
                fundForm,
                pledgeAmount,
                fundToken
            )
            await fundForm.connect(usr0).pledge(0, pledgeAmount, deadline, v, r, s)
            await ethers.provider.send('evm_increaseTime', [FIFTEEN_DAYS + 1])
            await ethers.provider.send('evm_mine', [])

            await expect(fundForm.withdrawFunds(0)).to.be.rejectedWith('Goal not met.')
        })

        describe('Pledges', () => {
            const pledgeAmount = ethers.utils.parseEther('1')
            it('Pledge - to active campaign', async () => {
                const { fundToken, fundForm, usr0 } = await loadFixture(deployV1ActiveCampaign)
                const { deadline, v, r, s } = await signERC20Permit(
                    usr0,
                    fundForm,
                    pledgeAmount,
                    fundToken
                )

                await fundForm.connect(usr0).pledge(0, pledgeAmount, deadline, v, r, s)
                expect((await fundForm.campaigns(0)).totalPledged).to.equal(pledgeAmount)
            })

            it('Pledge - to non-existent campaign', async () => {
                const { fundForm, fundToken, usr0 } = await loadFixture(deployV1ActiveCampaign)
                const { deadline, v, r, s } = await signERC20Permit(
                    usr0,
                    fundForm,
                    pledgeAmount,
                    fundToken
                )

                await expect(
                    fundForm.connect(usr0).pledge(1, pledgeAmount, deadline, v, r, s)
                ).to.be.rejectedWith('Campaign does not exist')
            })

            it('Pledge - to inactive campaign', async () => {
                const { fundForm, fundToken, usr0 } = await loadFixture(deployV1CompletedCampaign)
                const { deadline, v, r, s } = await signERC20Permit(
                    usr0,
                    fundForm,
                    pledgeAmount,
                    fundToken
                )
                await expect(
                    fundForm.connect(usr0).pledge(0, pledgeAmount, deadline, v, r, s)
                ).to.be.rejectedWith('This campaign has expired.')
            })

            it('Remove pledge - during active campaign', async () => {
                const { fundToken, fundForm, usr0 } = await loadFixture(deployV1ActiveCampaign)
                const { deadline, v, r, s } = await signERC20Permit(
                    usr0,
                    fundForm,
                    pledgeAmount,
                    fundToken
                )
                await fundForm.connect(usr0).pledge(0, pledgeAmount, deadline, v, r, s)

                await expect(fundForm.connect(usr0).removePledge(0)).to.be.rejectedWith(
                    'This campaign is active.'
                )
                await ethers.provider.send('evm_increaseTime', [FIFTEEN_DAYS + 1])
                await ethers.provider.send('evm_mine', [])

                await fundForm.connect(usr0).removePledge(0)
                expect((await fundForm.campaigns(0)).totalPledged).to.equal(0)
            })

            it('Remove pledge - twice', async () => {
                const { fundToken, fundForm, usr0 } = await loadFixture(deployV1ActiveCampaign)
                const { deadline, v, r, s } = await signERC20Permit(
                    usr0,
                    fundForm,
                    pledgeAmount,
                    fundToken
                )

                await fundForm.connect(usr0).pledge(0, pledgeAmount, deadline, v, r, s)

                await ethers.provider.send('evm_increaseTime', [FIFTEEN_DAYS + 1])
                await ethers.provider.send('evm_mine', [])
                await fundForm.connect(usr0).removePledge(0)
                await expect(fundForm.connect(usr0).removePledge(0)).to.changeTokenBalance(
                    fundToken,
                    usr0,
                    0
                )
            })

            it('Remove pledge - from inactive campaign', async () => {
                const { fundToken, fundForm, usr0 } = await loadFixture(deployV1CompletedCampaign)
                await expect(fundForm.connect(usr0).removePledge(0)).to.be.rejectedWith(
                    'Campaign goal was met'
                )
            })
        })
    })
    describe('V2', () => {
        it('Cancel campaign - campaign creator', async () => {
            const { fundForm, usr0 } = await loadFixture(deployV2)
            const goal = ethers.utils.parseEther('5')
            const deadline = Math.round(Date.now() / 1000) + FIFTEEN_DAYS + 100
            await fundForm.connect(usr0).createCampaign(goal, deadline)
            await fundForm.connect(usr0).cancelCampaign(0)
            expect(await fundForm.isArchivedCampaign(0)).to.equal(true)
        })

        it('Cancel campaign - FundForm owner', async () => {
            const { fundForm, usr0, deployer } = await loadFixture(deployV2)
            const goal = ethers.utils.parseEther('5')
            const deadline = Math.round(Date.now() / 1000) + FIFTEEN_DAYS + 100
            await fundForm.connect(usr0).createCampaign(goal, deadline)
            await fundForm.connect(deployer).cancelCampaign(0)
            expect(await fundForm.isArchivedCampaign(0)).to.equal(true)
        })

        it('Cancel campaign - unauthorized', async () => {
            const { fundForm, usr0, usr1 } = await loadFixture(deployV2)
            const goal = ethers.utils.parseEther('5')
            const deadline = Math.round(Date.now() / 1000) + FIFTEEN_DAYS + 100
            await fundForm.connect(usr0).createCampaign(goal, deadline)
            await expect(fundForm.connect(usr1).cancelCampaign(0)).to.be.rejectedWith(
                'Ownable: caller is not the owner'
            )
        })

        it('Cancel campaign - expired', async () => {
            const { fundToken, fundForm, usr0, usr1 } = await loadFixture(deployV2)
            const goal = ethers.utils.parseEther('5')
            const campaignDeadline = Math.round(Date.now() / 1000) + FIFTEEN_DAYS + 100
            await fundForm.connect(usr0).createCampaign(goal, campaignDeadline)

            await ethers.provider.send('evm_increaseTime', [FIFTEEN_DAYS + 101])
            await ethers.provider.send('evm_mine', [])
            await expect(fundForm.connect(usr0).cancelCampaign(0)).to.be.rejectedWith(
                'This campaign has expired.'
            )
        })
    })
})
