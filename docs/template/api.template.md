# bongle API reference

Curated reference for the public `bongle` surface. For a guided,
read-top-to-bottom introduction see [the guide](./guide.md).

## Transforms & scene graph

Read and write node positions in local and world space.

### Setters

Write local-space values; each marks the node dirty so descendants recompute.

<Render select="api/transforms:setPosition" heading />
<Render select="api/transforms:setQuaternion" heading />
<Render select="api/transforms:setScale" heading />
<Render select="api/transforms:setTransform" heading />

### World-space getters

Read resolved world-space values, recomputing lazily if anything upstream moved.

<Render select="api/transforms:getWorldPosition" heading />
<Render select="api/transforms:getWorldQuaternion" heading />
<Render select="api/transforms:getWorldScale" heading />
<Render select="api/transforms:getWorldMatrix" heading />
