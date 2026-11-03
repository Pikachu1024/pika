import { z } from "zod";

const positiveInteger = z.number().int().positive();

export const ModelPresetSchema = z.object({
  name: z.string().min(1),
  model: z.string().min(1),
  baseUrl: z.string().min(1),
  /** Name of the environment variable holding the key; values are never stored. */
  apiKeyEnv: z.string().min(1).optional(),
  contextWindow: positiveInteger.optional(),
  maxTokens: positiveInteger.optional(),
  /** Defaults to true; false keeps built-in tools out of the provider request. */
  tools: z.boolean().optional(),
});

export const ModelCatalogSchema = z
  .object({
    default: z.string().min(1).optional(),
    models: z.array(ModelPresetSchema),
  })
  .superRefine((catalog, context) => {
    const names = new Set<string>();
    for (const [index, preset] of catalog.models.entries()) {
      if (names.has(preset.name)) {
        context.addIssue({
          code: "custom",
          path: ["models", index, "name"],
          message: `duplicate model preset name: ${preset.name}`,
        });
      }
      names.add(preset.name);
    }
    if (catalog.default !== undefined && !names.has(catalog.default)) {
      context.addIssue({
        code: "custom",
        path: ["default"],
        message: `default model preset not found: ${catalog.default}`,
      });
    }
  });

export type ModelPreset = z.infer<typeof ModelPresetSchema>;
export type ModelCatalog = z.infer<typeof ModelCatalogSchema>;
