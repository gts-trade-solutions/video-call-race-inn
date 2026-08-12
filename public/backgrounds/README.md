# Call backgrounds

Drop three images here, named exactly:

    bg-1.jpg
    bg-2.jpg
    bg-3.jpg

They appear as background options in a call (Effects → Background).
`.png` works too — rename the entries in `src/components/call/EffectsPanel.tsx`
if you use a different extension.

A slot whose file is missing is simply not shown, so the panel never displays a
broken image. Landscape images around 1920×1080 look best; the segmentation
model composites the person over whatever is here.
