import { serializeNode, jsonValue, type SerializableNode } from "./serializer";

export async function designContext(
  roots: SerializableNode[],
  options: { depth: number; maxNodes: number; includeHidden: boolean; includeCss: boolean }
) {
  let nodeCount = 0;
  const omitted: string[] = [];
  const warnings: string[] = [];
  const assets: Record<string, unknown>[] = [];
  const components: Record<string, unknown> = {};
  const variables: Record<string, unknown> = {};
  const variableCache = new Map<string, Variable | null>();
  const componentCache = new Map<string, ComponentNode | null>();

  async function visit(
    node: SerializableNode,
    depth: number
  ): Promise<Record<string, unknown> | null> {
    if (nodeCount >= options.maxNodes) {
      omitted.push(node.id);
      return null;
    }
    nodeCount++;
    const result = serializeNode(node, { depth: 0, includeHidden: options.includeHidden });
    const out: Record<string, unknown> = { ...result };
    if (options.includeCss && "getCSSAsync" in node) {
      try {
        out.css = await node.getCSSAsync();
      } catch (e) {
        warnings.push(`${node.id}: CSS unavailable: ${String(e)}`);
      }
    }
    if (node.type === "INSTANCE") {
      try {
        // Cache by instance ID: overridden/swapped instances need their own main component.
        if (!componentCache.has(node.id))
          componentCache.set(node.id, await node.getMainComponentAsync());
        const component = componentCache.get(node.id);
        if (component) {
          out.mainComponentId = component.id;
          const definitionOwner =
            component.parent?.type === "COMPONENT_SET" ? component.parent : component;
          components[component.id] = {
            id: component.id,
            key: component.key,
            name: component.name,
            description: component.description || definitionOwner.description,
            descriptionMarkdown:
              component.descriptionMarkdown || definitionOwner.descriptionMarkdown,
            documentationLinks: component.documentationLinks.length
              ? component.documentationLinks
              : definitionOwner.documentationLinks,
            componentPropertyDefinitions: jsonValue(definitionOwner.componentPropertyDefinitions),
            componentSet:
              component.parent?.type === "COMPONENT_SET"
                ? {
                    id: component.parent.id,
                    name: component.parent.name,
                    description: component.parent.description,
                  }
                : undefined,
          };
        }
      } catch (e) {
        warnings.push(`${node.id}: component unavailable: ${String(e)}`);
      }
    }
    const aliases = new Set<string>();
    function collect(value: unknown) {
      if (!value || typeof value !== "object") return;
      if ("type" in value && value.type === "VARIABLE_ALIAS" && "id" in value)
        aliases.add(String(value.id));
      for (const child of Object.values(value)) collect(child);
    }
    collect(result);
    const resolved: Record<string, unknown> = {};
    if (node.type !== "PAGE")
      for (const id of aliases) {
        try {
          if (!variableCache.has(id))
            variableCache.set(id, await figma.variables.getVariableByIdAsync(id));
          const variable = variableCache.get(id);
          if (variable) {
            variables[id] = {
              id,
              name: variable.name,
              collectionId: variable.variableCollectionId,
              resolvedType: variable.resolvedType,
              valuesByMode: jsonValue(variable.valuesByMode),
              codeSyntax: variable.codeSyntax,
              description: variable.description,
            };
            resolved[id] = jsonValue(variable.resolveForConsumer(node));
          } else warnings.push(`${node.id}: variable ${id} is unavailable`);
        } catch (e) {
          warnings.push(`${node.id}: variable ${id}: ${String(e)}`);
        }
      }
    if (aliases.size) out.resolvedVariables = resolved;
    if ("fills" in node && Array.isArray(node.fills)) {
      for (const paint of node.fills)
        if (paint.type === "IMAGE" && paint.imageHash) {
          assets.push({
            nodeId: node.id,
            name: node.name,
            kind: "IMAGE_FILL",
            imageHash: paint.imageHash,
            visible: paint.visible !== false,
            scaleMode: paint.scaleMode,
            imageTransform: paint.imageTransform,
            original:
              "Use save_image with imageHash; use save_screenshots for rendered crop/effects.",
          });
        }
    }
    if (["VECTOR", "BOOLEAN_OPERATION", "INSTANCE", "COMPONENT", "GROUP"].includes(node.type)) {
      assets.push({
        nodeId: node.id,
        name: node.name,
        kind: "SVG_CANDIDATE",
        format: "SVG",
        bounds: result.bounds,
        export: "save_screenshots with this nodeId and format SVG",
      });
    }
    if ("children" in node) {
      const children = node.children.filter((c) => options.includeHidden || c.visible !== false);
      if (depth >= options.depth) {
        if (children.length) omitted.push(node.id);
      } else {
        const outputChildren = [];
        for (const child of children) {
          const data = await visit(child, depth + 1);
          if (data) outputChildren.push(data);
        }
        out.children = outputChildren;
      }
    }
    return out;
  }
  const context = [];
  for (const root of roots) {
    const data = await visit(root, 0);
    if (data) context.push(data);
  }
  return {
    schemaVersion: 2,
    capturedAt: new Date().toISOString(),
    nodeCount,
    truncated: omitted.length > 0,
    omittedNodeIds: omitted,
    warnings,
    context,
    components,
    variables,
    assets,
    guidance:
      "Use source values and per-side strokeWeights. CSS is supplemental, not a rendered implementation. Text range indices are UTF-16. Resolve variables per consumer. Download SVG candidates only at the intended asset root; do not export both a parent and its children for the same slot. Verify against a separately exported screenshot; captures are not atomic.",
  };
}
