import { z } from "zod";

// Standard 15-character GSTIN format: 2 digit state code, 10 char PAN, entity code, Z, checksum.
export const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
export const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;
export const PHONE_REGEX = /^[6-9][0-9]{9}$/;
export const HSN_REGEX = /^[0-9]{4,8}$/;

export const gstinSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(GSTIN_REGEX, "Invalid GSTIN format")
  .optional()
  .or(z.literal(""));

export const panSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(PAN_REGEX, "Invalid PAN format")
  .optional()
  .or(z.literal(""));

export const phoneSchema = z
  .string()
  .trim()
  .regex(PHONE_REGEX, "Invalid Indian mobile number")
  .optional()
  .or(z.literal(""));

export const hsnSchema = z
  .string()
  .trim()
  .regex(HSN_REGEX, "HSN code must be 4-8 digits")
  .optional()
  .or(z.literal(""));
