export const escapeAirtableString = (value: string) => String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');

export const airtableEq = (fieldName: string, value: string) => `{${fieldName}}="${escapeAirtableString(value)}"`;

export const airtableIsBlank = (fieldName: string) => `{${fieldName}}=""`;

export const accountKeyFilterFormula = (params: {
  fieldName: string;
  accountKey: string;
  treatBlankAsAccount?: boolean;
}) => {
  const eq = airtableEq(params.fieldName, params.accountKey);
  if (params.treatBlankAsAccount) {
    return `OR(${airtableIsBlank(params.fieldName)}, ${eq})`;
  }
  return eq;
};

