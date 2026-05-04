use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::{constants::*, error::TollgateError, state::*};

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut)]
    pub server: Signer<'info>,

    #[account(
        mut,
        has_one = server,
        seeds = [
            ESCROW_SEED,
            escrow.payer.as_ref(),
            escrow.server.as_ref(),
            &escrow.nonce.to_le_bytes(),
        ],
        bump = escrow.bump,
    )]
    pub escrow: Account<'info, Escrow>,

    #[account(
        mut,
        seeds = [VAULT_SEED, escrow.key().as_ref()],
        bump = escrow.vault_bump,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = escrow.mint,
        token::authority = server,
    )]
    pub server_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn claim(ctx: Context<Claim>, receipt: Vec<u8>) -> Result<()> {
    require!(
        ctx.accounts.escrow.status == EscrowStatus::Open,
        TollgateError::NotOpen
    );
    require!(
        receipt.len() <= MAX_RECEIPT_LEN,
        TollgateError::ReceiptTooLong
    );
    let now = Clock::get()?.unix_timestamp;
    require!(now <= ctx.accounts.escrow.deadline, TollgateError::AlreadyExpired);

    let amount = ctx.accounts.escrow.amount;
    let payer_key = ctx.accounts.escrow.payer;
    let server_key = ctx.accounts.escrow.server;
    let nonce_bytes = ctx.accounts.escrow.nonce.to_le_bytes();
    let bump = ctx.accounts.escrow.bump;

    let seeds: &[&[u8]] = &[
        ESCROW_SEED,
        payer_key.as_ref(),
        server_key.as_ref(),
        &nonce_bytes,
        &[bump],
    ];
    let signer_seeds = &[seeds];

    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.vault.to_account_info(),
            to: ctx.accounts.server_token_account.to_account_info(),
            authority: ctx.accounts.escrow.to_account_info(),
        },
        signer_seeds,
    );
    token::transfer(cpi_ctx, amount)?;

    let escrow = &mut ctx.accounts.escrow;
    escrow.status = EscrowStatus::Claimed;
    escrow.settled_at = now;
    escrow.receipt_len = receipt.len() as u8;
    escrow.receipt = [0u8; 64];
    escrow.receipt[..receipt.len()].copy_from_slice(&receipt);

    Ok(())
}
