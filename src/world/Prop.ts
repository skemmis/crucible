import { PhysicsNode } from '../physics/PhysicsNode';

/**
 * Types of manipulable props agents can grab, connect, and release.
 *
 * Each type has distinct physical properties that create different
 * strategic trade-offs for agents that learn to use them:
 *
 *  stone   — dense and heavy; hard to carry but stable as structure
 *  wood    — light and medium-sized; easy to move, good for spanning
 *  metal   — very heavy and small; almost impossible to carry but
 *            creates rigid anchor points when connected
 *  cushion — extremely light and large; easy to carry, useful as
 *            a physical buffer or landing pad
 */
export type PropType = 'stone' | 'wood' | 'metal' | 'cushion';

export interface PropTypeConfig {
  mass: number;
  radius: number;
  /** HSL hue [0, 360] used by the renderer. */
  hue: number;
  /** HSL saturation [0, 1]. */
  sat: number;
  /** HSL lightness [0, 1] at full visibility. */
  lit: number;
}

export const PROP_TYPE_CONFIGS: Record<PropType, PropTypeConfig> = {
  stone:   { mass: 3.0, radius: 8,  hue: 220, sat: 0.08, lit: 0.45 },  // blue-grey
  wood:    { mass: 1.2, radius: 7,  hue:  30, sat: 0.55, lit: 0.40 },  // warm brown
  metal:   { mass: 5.0, radius: 6,  hue: 195, sat: 0.25, lit: 0.50 },  // steel-blue
  cushion: { mass: 0.5, radius: 10, hue: 280, sat: 0.60, lit: 0.55 },  // purple
};

export const PROP_TYPES: PropType[] = ['stone', 'wood', 'metal', 'cushion'];

let _nextPropId = 0;

export class Prop {
  readonly id: number;
  readonly type: PropType;
  readonly node: PhysicsNode;

  /**
   * Id of the agent currently gripping this prop via a grab spring,
   * or null when the prop is free.
   */
  carriedBy: number | null = null;

  constructor(type: PropType, x: number, y: number, z: number) {
    this.id = _nextPropId++;
    this.type = type;
    const cfg = PROP_TYPE_CONFIGS[type];
    this.node = new PhysicsNode(x, y, z, cfg.mass, cfg.radius);
  }
}
