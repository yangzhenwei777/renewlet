import { z } from "zod";
import mediaResolverFixturesJson from "../data/media-resolver-fixtures.json";
import { mediaCandidateKindSchema, mediaCandidateModeSchema } from "./schemas/media";

const mediaResolverFixtureSchema = z.object({
  id: z.string().min(1),
  kind: mediaCandidateKindSchema,
  mode: mediaCandidateModeSchema,
  name: z.string().min(1),
  website: z.string().optional(),
  limit: z.number().int().positive().optional(),
  expectedAutoLabel: z.string().nullable().optional(),
  expectedFirstBuiltInLabel: z.string().optional(),
  expectedMatchedQuery: z.string().optional(),
  expectedFirstFaviconProvider: z.string().optional(),
  expectedFirstFaviconLabel: z.string().optional(),
  expectedFaviconAutoAssignable: z.boolean().optional(),
}).strict();

/**
 * mediaResolverFixtures 是跨运行面候选解析的回归样例。
 *
 * fixture 数据由 shared schema 校验后供测试使用，避免 Docker/Cloudflare 对同一查询返回不同排序语义。
 */
export const mediaResolverFixtures = z.array(mediaResolverFixtureSchema).parse(mediaResolverFixturesJson);

export type MediaResolverFixture = (typeof mediaResolverFixtures)[number];
