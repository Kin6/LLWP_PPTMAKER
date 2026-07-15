# DeckForge Design System

## Direction

Light productivity workspace for long daytime editing sessions. Restrained warm neutrals, one vermilion action color, blue for information, green for success, and no decorative gradients.

## Color

- Canvas: `oklch(0.965 0.007 80)`
- Surface: `oklch(0.992 0.004 80)`
- Raised surface: `oklch(0.978 0.006 80)`
- Text: `oklch(0.235 0.018 55)`
- Muted text: `oklch(0.51 0.018 55)`
- Border: `oklch(0.89 0.012 70)`
- Primary action: `oklch(0.61 0.19 35)`
- Information: `oklch(0.55 0.13 235)`
- Success: `oklch(0.58 0.14 150)`
- Warning: `oklch(0.72 0.15 75)`

## Typography

Use the native system sans stack with Microsoft YaHei for Chinese. UI headings stay between 14px and 20px. Body and controls use 12px to 14px. Use weight and spacing for hierarchy, never display typography inside compact panels.

## Layout

Desktop uses a compact top bar and a Manus-like three-column workspace: a source rail, a five-step agent timeline, and a flexible artifact canvas. The artifact canvas contains the story thesis, slide preview, navigator, and native text editor. Mobile collapses to one column with actions kept reachable.

## Components

- Controls use 6px radii, 40px minimum height, visible hover, focus, disabled, and loading states.
- Segmented controls are used for local versus AI mode.
- API configuration is an inline disclosure panel, not a modal, and separates text/vision service credentials from Image 2 credentials.
- Cards are reserved for repeated slide thumbnails and evidence items.
- Status uses text plus an icon; color is supportive, never the only signal.

## Motion

Use 160ms to 220ms ease-out transitions for hover, focus, disclosure, and selection state only. Respect `prefers-reduced-motion`.
