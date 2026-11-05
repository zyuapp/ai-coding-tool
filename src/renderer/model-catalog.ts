import { createContext, useContext } from "react";
import { BUILT_IN_MODELS, type ModelCatalog } from "../domain/agent-engine";

/** The models the computer on screen can run, which every picker and model label reads. */
const ModelCatalogContext = createContext<ModelCatalog>(BUILT_IN_MODELS);

export const ModelCatalogProvider = ModelCatalogContext.Provider;

export function useModelCatalog(): ModelCatalog {
  return useContext(ModelCatalogContext);
}
