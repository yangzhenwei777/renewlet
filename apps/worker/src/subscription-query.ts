const COLLECTION_REPEATED_QUERY_KEYS = new Set([
  "category",
  "tag",
  "billingCycle",
  "paymentMethod",
  "currency",
]);

/** 保留未知参数交给 shared strict schema 拒绝，避免 index 静默吞掉 limit/cursor 后形成隐式兼容契约。 */
export function subscriptionCollectionQueryInput(params: URLSearchParams): Record<string, string | string[]> {
  return subscriptionQueryInput(params, COLLECTION_REPEATED_QUERY_KEYS);
}

export function subscriptionSingleValueQueryInput(params: URLSearchParams): Record<string, string | string[]> {
  return subscriptionQueryInput(params, new Set<string>());
}

function subscriptionQueryInput(
  params: URLSearchParams,
  repeatedKeys: ReadonlySet<string>,
): Record<string, string | string[]> {
  const input: Record<string, string | string[]> = {};
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    input[key] = repeatedKeys.has(key) || values.length !== 1 ? values : values[0] ?? "";
  }
  return input;
}
