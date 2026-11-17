import { Prisma } from "@prisma/client";
import type { Expense, PaymentType } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { toDecimal } from "../../lib/decimal";
import { AppError } from "../../middleware/errorHandler";
import { allocateNumber } from "../invoice/numbering";
import { writeAudit } from "../audit/audit";
import type { ActionContext } from "../documents/documentService";

export interface ExpenseInput {
  date: Date;
  categoryName: string;
  amount: number;
  mode: PaymentType;
  paidTo?: string | null;
  note?: string | null;
  clientToken?: string | null;
}

export async function createExpense(ctx: ActionContext, input: ExpenseInput): Promise<{ expense: Expense; duplicate: boolean }> {
  const business = ctx.business;
  if (!(input.amount > 0)) throw new AppError("Amount must be more than 0", 422);
  if (!input.categoryName.trim()) throw new AppError("Choose or type an expense category", 422);
  if (input.mode === "CREDIT") throw new AppError("Choose how the expense was paid", 422);
  if (input.clientToken) {
    const already = await prisma.expense.findUnique({ where: { clientToken: input.clientToken } });
    if (already) return { expense: already, duplicate: true };
  }

  try {
    const expense = await prisma.$transaction(async (tx) => {
      const category = await tx.expenseCategory.upsert({
        where: { businessId_name: { businessId: business.id, name: input.categoryName.trim() } },
        create: { businessId: business.id, name: input.categoryName.trim() },
        update: {},
      });
      const expenseNo = await allocateNumber(
        tx,
        business.id,
        business.settings?.expensePrefix ?? "EXP-",
        { financialYearFormat: business.settings?.financialYearFormat ?? false, invoiceStartNumber: 1 },
        input.date
      );
      const created = await tx.expense.create({
        data: {
          businessId: business.id,
          expenseNo,
          date: input.date,
          categoryId: category.id,
          amount: toDecimal(input.amount).toFixed(2),
          mode: input.mode,
          paidTo: input.paidTo?.trim() || null,
          note: input.note?.trim() || null,
          clientToken: input.clientToken || null,
        },
      });
      await writeAudit(tx, { businessId: business.id, userId: ctx.userId, entity: "EXPENSE", entityId: created.id, action: "CREATE", detail: { expenseNo, amount: created.amount.toString() } });
      return created;
    });
    return { expense, duplicate: false };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002" && input.clientToken) {
      const already = await prisma.expense.findUnique({ where: { clientToken: input.clientToken } });
      if (already) return { expense: already, duplicate: true };
    }
    throw err;
  }
}

export async function cancelExpense(ctx: ActionContext, id: string, reason: string): Promise<Expense> {
  return prisma.$transaction(async (tx) => {
    const expense = await tx.expense.findFirst({ where: { id, businessId: ctx.business.id } });
    if (!expense) throw new AppError("Expense not found", 404);
    const flipped = await tx.expense.updateMany({
      where: { id, status: "ACTIVE" },
      data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: reason.trim() || null },
    });
    if (flipped.count === 0) throw new AppError(`${expense.expenseNo} is already cancelled`, 409);
    await writeAudit(tx, { businessId: ctx.business.id, userId: ctx.userId, entity: "EXPENSE", entityId: id, action: "CANCEL", detail: { expenseNo: expense.expenseNo, reason: reason.trim() } });
    return tx.expense.findUniqueOrThrow({ where: { id } });
  });
}
