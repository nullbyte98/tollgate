use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum EscrowStatus {
    Open,
    Claimed,
    Refunded,
}

#[account]
pub struct Escrow {
    pub payer: Pubkey,
    pub server: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub deadline: i64,
    pub opened_at: i64,
    pub settled_at: i64,
    pub nonce: u64,
    pub status: EscrowStatus,
    pub bump: u8,
    pub vault_bump: u8,
    pub receipt_len: u8,
    pub receipt: [u8; 64],
}

impl Escrow {
    // discriminator(8) + payer(32) + server(32) + mint(32) + amount(8)
    // + deadline(8) + opened_at(8) + settled_at(8) + nonce(8)
    // + status(1+) + bump(1) + vault_bump(1) + receipt_len(1) + receipt(64)
    pub const SIZE: usize = 8 + 32 + 32 + 32 + 8 + 8 + 8 + 8 + 8 + 2 + 1 + 1 + 1 + 64;
}
