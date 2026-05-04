use anchor_lang::prelude::*;

#[error_code]
pub enum TollgateError {
    #[msg("Escrow is not in the Open state")]
    NotOpen,
    #[msg("Deadline must be in the future")]
    InvalidDeadline,
    #[msg("Amount must be greater than zero")]
    InvalidAmount,
    #[msg("Deadline has not yet passed")]
    NotYetExpired,
    #[msg("Deadline has already passed")]
    AlreadyExpired,
    #[msg("Receipt exceeds maximum length")]
    ReceiptTooLong,
    #[msg("Arithmetic overflow")]
    Overflow,
}
