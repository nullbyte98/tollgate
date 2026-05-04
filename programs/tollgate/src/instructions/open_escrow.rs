use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, Transfer},
};

use crate::{constants::*, error::TollgateError, state::*};

#[derive(Accounts)]
#[instruction(amount: u64, deadline: i64, nonce: u64)]
pub struct OpenEscrow<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: server pubkey is just stored; signed verification happens in claim
    pub server: UncheckedAccount<'info>,

    pub mint: Account<'info, Mint>,

    #[account(
        init,
        payer = payer,
        space = Escrow::SIZE,
        seeds = [
            ESCROW_SEED,
            payer.key().as_ref(),
            server.key().as_ref(),
            &nonce.to_le_bytes(),
        ],
        bump,
    )]
    pub escrow: Account<'info, Escrow>,

    #[account(
        init,
        payer = payer,
        seeds = [VAULT_SEED, escrow.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = escrow,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = payer,
    )]
    pub payer_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn open_escrow(
    ctx: Context<OpenEscrow>,
    amount: u64,
    deadline: i64,
    nonce: u64,
) -> Result<()> {
    require!(amount > 0, TollgateError::InvalidAmount);
    let now = Clock::get()?.unix_timestamp;
    require!(deadline > now, TollgateError::InvalidDeadline);

    let cpi_ctx = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.payer_token_account.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.payer.to_account_info(),
        },
    );
    token::transfer(cpi_ctx, amount)?;

    let escrow = &mut ctx.accounts.escrow;
    escrow.payer = ctx.accounts.payer.key();
    escrow.server = ctx.accounts.server.key();
    escrow.mint = ctx.accounts.mint.key();
    escrow.amount = amount;
    escrow.deadline = deadline;
    escrow.opened_at = now;
    escrow.settled_at = 0;
    escrow.nonce = nonce;
    escrow.status = EscrowStatus::Open;
    escrow.bump = ctx.bumps.escrow;
    escrow.vault_bump = ctx.bumps.vault;
    escrow.receipt_len = 0;
    escrow.receipt = [0u8; 64];

    Ok(())
}
