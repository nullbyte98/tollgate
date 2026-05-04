use anchor_lang::prelude::*;

pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("GnBmtnw4kpxDK2vswPLYyuiW2ysb32BUh7aTXpeX8kpb");

#[program]
pub mod tollgate {
    use super::*;

    /// Payer locks `amount` of `mint` into a fresh escrow PDA.
    /// `deadline` is a unix timestamp; after it passes, anyone can crank a refund.
    /// `nonce` lets the same (payer, server) pair open many escrows in parallel.
    pub fn open_escrow(
        ctx: Context<OpenEscrow>,
        amount: u64,
        deadline: i64,
        nonce: u64,
    ) -> Result<()> {
        instructions::open_escrow::open_escrow(ctx, amount, deadline, nonce)
    }

    /// Server claims the escrow, optionally recording an opaque receipt
    /// (e.g. a hash of the served response) for off-chain audit.
    pub fn claim(ctx: Context<Claim>, receipt: Vec<u8>) -> Result<()> {
        instructions::claim::claim(ctx, receipt)
    }

    /// After deadline, anyone can crank a refund back to the payer.
    pub fn refund_timeout(ctx: Context<RefundTimeout>) -> Result<()> {
        instructions::refund_timeout::refund_timeout(ctx)
    }

    /// Server can voluntarily refund (e.g. self-detected failure) at any time
    /// before claim or timeout.
    pub fn refund_by_server(ctx: Context<RefundByServer>) -> Result<()> {
        instructions::refund_by_server::refund_by_server(ctx)
    }
}
