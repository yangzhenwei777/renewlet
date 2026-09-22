// 管理员接口 schema 由 shared 统一出口；前端仍在 apiFetch 层运行时校验，不能退回纯 TS 类型断言。
export * from "@renewlet/shared/schemas/admin";
