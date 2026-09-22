import { apiFetch } from "@/lib/api-client";
import { okResponseSchema } from "@/lib/api/schemas/common";
import {
  uploadImageResponseSchema,
  uploadedAssetsPageResponseSchema,
  type ApiUploadImageResponse,
  type UploadedAsset,
  type UploadedAssetsPage,
  type UploadKind,
} from "@/lib/api/schemas/media";
import { getApiLocale } from "@/i18n/api-locale";
import { translate } from "@/i18n/messages";
import { getCurrentUserId } from "@/lib/pocketbase";

/**
 * UploadedAsset 是 Logo 选择器可复用的私有资产视图。
 *
 * `url` 始终是 `/api/app/assets/{id}` 受控代理路径；调用方不应依赖 PocketBase 文件名或 Cloudflare R2 key。
 */
export type { UploadedAsset, UploadedAssetsPage };

/**
 * UploadedAssetPage 描述上传资产分页结果。
 *
 * 两种运行面都返回同一页码契约，前端 hook 才能用同一套“加载更多 + 去重”状态机。
 */
const UPLOADED_ASSETS_PAGE_SIZE = 48;

/**
 * assetService 统一走 Renewlet 产品 API 上传和列出资产。
 *
 * 前端只消费受控资产 URL；Docker 的 PocketBase 文件字段和 Cloudflare 的 R2 key 都被隔离在后端。
 */
export const assetService = {
  /**
   * 上传 Logo/Icon 文件并返回受控读取 URL。
   *
   * @param file 浏览器选择或导入流程生成的图片 Blob。
   * @param kind 资产用途，服务端据此隔离 Logo/Icon 查询。
   * @param filename 原始文件名，仅用于服务端 metadata 和 R2 key 可诊断性，不作为权限依据。
   */
  async create(file: Blob, kind: UploadKind, filename: string): Promise<ApiUploadImageResponse> {
    const form = new FormData();
    const userId = getCurrentUserId();
    if (!userId) throw new Error(translate(getApiLocale(), "auth.loginRequired"));
    form.append("kind", kind);
    form.append("file", file, filename);

    return await apiFetch("/api/app/assets", uploadImageResponseSchema, {
      method: "POST",
      body: form,
    });
  },

  /**
   * 分页列出当前用户上传的指定类型资产；Logo 选择器与设置页共用这条可取消数据流。
   */
  async list(kind: UploadKind, page: number, signal?: AbortSignal): Promise<UploadedAssetsPage> {
    const params = new URLSearchParams({ kind, page: String(page), perPage: String(UPLOADED_ASSETS_PAGE_SIZE) });
    return await apiFetch(
      `/api/app/assets?${params.toString()}`,
      uploadedAssetsPageResponseSchema,
      signal ? { signal } : undefined,
    );
  },

  /**
   * 删除当前用户拥有的上传资产。
   *
   * 后端会阻止删除仍被订阅 logo 引用的资产；前端只负责展示该业务错误，不做本地级联清空。
   */
  async delete(id: string): Promise<void> {
    await apiFetch(`/api/app/assets/${encodeURIComponent(id)}`, okResponseSchema, { method: "DELETE" });
  },
};
