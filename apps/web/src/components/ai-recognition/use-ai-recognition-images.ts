import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/i18n/I18nProvider";
import { AI_RECOGNITION_MAX_IMAGE_BYTES, AI_RECOGNITION_MAX_IMAGES } from "@/lib/api/schemas/ai-recognition";
import {
  AIRecognitionImagePreprocessError,
  aiRecognitionImageTargetBytes,
  isAIRecognitionImageAbort,
  prepareAIRecognitionImage,
  type PreparedAIRecognitionImage,
} from "@/modules/ai-recognition/domain/ai-image-preprocess";
import {
  createObjectUrl,
  nextImageId,
  revokeImageItem,
  revokeImageItems,
} from "./ai-recognition-dialog-utils";
import type { AIRecognitionImageItem } from "./ai-recognition-dialog-types";

const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

interface UseAIRecognitionImagesOptions {
  setError: (error: string | null) => void;
  onInputChanged: () => void;
}

export function useAIRecognitionImages({ setError, onInputChanged }: UseAIRecognitionImagesOptions) {
  const { t } = useI18n();
  const imageItemsRef = useRef<AIRecognitionImageItem[]>([]);
  const imageIdRef = useRef(0);
  const preprocessRunRef = useRef(0);
  const preprocessAbortRef = useRef<AbortController | null>(null);
  const [images, setImages] = useState<AIRecognitionImageItem[]>([]);
  const [processingCount, setProcessingCount] = useState(0);

  useEffect(() => {
    imageItemsRef.current = images;
  }, [images]);

  const discardProcessing = useCallback(() => {
    preprocessRunRef.current += 1;
    preprocessAbortRef.current?.abort();
    preprocessAbortRef.current = null;
  }, []);

  const cancelProcessing = useCallback(() => {
    discardProcessing();
    setProcessingCount(0);
  }, [discardProcessing]);

  const resetImages = useCallback(() => {
    discardProcessing();
    revokeImageItems(imageItemsRef.current);
    imageItemsRef.current = [];
    imageIdRef.current = 0;
    setProcessingCount(0);
    setImages([]);
  }, [discardProcessing]);

  useEffect(() => () => {
    discardProcessing();
    revokeImageItems(imageItemsRef.current);
  }, [discardProcessing]);

  const addImages = useCallback(async (files: File[]) => {
    if (files.length === 0 || processingCount > 0) return;
    setError(null);
    const nextCandidates: File[] = [];
    let nextError: string | null = null;
    const availableSlots = AI_RECOGNITION_MAX_IMAGES - imageItemsRef.current.length;

    for (const file of files) {
      if (nextCandidates.length >= availableSlots) {
        nextError = t("aiRecognition.imageLimit", { count: AI_RECOGNITION_MAX_IMAGES });
        break;
      }
      if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
        nextError = t("aiRecognition.imageInvalid");
        continue;
      }
      if (file.size > AI_RECOGNITION_MAX_IMAGE_BYTES) {
        nextError = t("aiRecognition.imageTooLarge");
        continue;
      }
      nextCandidates.push(file);
    }

    if (nextCandidates.length === 0) {
      if (nextError) setError(nextError);
      return;
    }

    const runId = preprocessRunRef.current + 1;
    preprocessRunRef.current = runId;
    preprocessAbortRef.current?.abort();
    const controller = new AbortController();
    preprocessAbortRef.current = controller;
    setProcessingCount(nextCandidates.length);

    const preparedImages: PreparedAIRecognitionImage[] = [];
    try {
      const finalImageCount = imageItemsRef.current.length + nextCandidates.length;
      const targetBytes = aiRecognitionImageTargetBytes(finalImageCount);
      for (const file of nextCandidates) {
        const prepared = await prepareAIRecognitionImage(file, { targetBytes, signal: controller.signal });
        if (preprocessRunRef.current !== runId) return;
        preparedImages.push(prepared);
      }
      if (preprocessRunRef.current !== runId) return;
      // 只有当前批次完全有效时才创建 object URL，避免取消或半失败批次留下不可回收的缩略图资源。
      const preparedItems = preparedImages.map((prepared) => ({
        id: nextImageId(imageIdRef),
        file: prepared.file,
        thumbnailUrl: createObjectUrl(prepared.file),
        originalSizeBytes: prepared.originalSizeBytes,
        targetSizeBytes: prepared.targetSizeBytes,
        optimized: prepared.optimized,
        optimizationWarning: prepared.warning,
      }));
      const nextImages = [...imageItemsRef.current, ...preparedItems];
      imageItemsRef.current = nextImages;
      setImages(nextImages);
      onInputChanged();
      if (preparedItems.some((image) => image.optimizationWarning)) {
        setError(t("aiRecognition.imageLargeAfterOptimization"));
      } else if (nextError) {
        setError(nextError);
      }
    } catch (error) {
      if (isAIRecognitionImageAbort(error) || preprocessRunRef.current !== runId) return;
      if (error instanceof AIRecognitionImagePreprocessError && error.code === "too-large") {
        setError(t("aiRecognition.imageTooLarge"));
      } else {
        setError(t("aiRecognition.imageOptimizeFailed"));
      }
    } finally {
      if (preprocessRunRef.current === runId) {
        preprocessAbortRef.current = null;
        setProcessingCount(0);
      }
    }
  }, [onInputChanged, processingCount, setError, t]);

  const removeImage = useCallback((id: string) => {
    const removed = imageItemsRef.current.find((image) => image.id === id);
    const nextImages = imageItemsRef.current.filter((image) => image.id !== id);
    if (removed) revokeImageItem(removed);
    imageItemsRef.current = nextImages;
    setImages(nextImages);
    if (removed) onInputChanged();
  }, [onInputChanged]);

  return {
    images,
    imageProcessing: processingCount > 0,
    imageProcessingCount: processingCount,
    addImages,
    removeImage,
    resetImages,
    cancelProcessing,
    abortProcessing: discardProcessing,
  };
}
