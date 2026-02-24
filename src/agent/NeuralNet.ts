/** Minimal 2-layer feedforward network (input → hidden → output), tanh activations. */
export class NeuralNet {
  w1: number[][]; // [hiddenSize][inputSize]
  b1: number[];   // [hiddenSize]
  w2: number[][]; // [outputSize][hiddenSize]
  b2: number[];   // [outputSize]

  constructor(
    public inputSize: number,
    public hiddenSize: number,
    public outputSize: number,
    weights?: { w1: number[][], b1: number[], w2: number[][], b2: number[] },
  ) {
    if (weights) {
      this.w1 = weights.w1;
      this.b1 = weights.b1;
      this.w2 = weights.w2;
      this.b2 = weights.b2;
    } else {
      this.w1 = NeuralNet.randMatrix(hiddenSize, inputSize, 1.0);
      this.b1 = NeuralNet.randVec(hiddenSize, 0.1);
      this.w2 = NeuralNet.randMatrix(outputSize, hiddenSize, 1.0);
      this.b2 = NeuralNet.randVec(outputSize, 0.1);
    }
  }

  forward(inputs: number[]): number[] {
    // Hidden layer
    const hidden = new Array<number>(this.hiddenSize);
    for (let i = 0; i < this.hiddenSize; i++) {
      let s = this.b1[i];
      const row = this.w1[i];
      for (let j = 0; j < this.inputSize; j++) s += row[j] * inputs[j];
      hidden[i] = Math.tanh(s);
    }
    // Output layer
    const out = new Array<number>(this.outputSize);
    for (let i = 0; i < this.outputSize; i++) {
      let s = this.b2[i];
      const row = this.w2[i];
      for (let j = 0; j < this.hiddenSize; j++) s += row[j] * hidden[j];
      out[i] = Math.tanh(s);
    }
    return out;
  }

  /**
   * Return a new NeuralNet with Gaussian perturbations.
   * If outputSize changes (due to morphological mutation), re-init output layer.
   */
  mutate(rate: number = 0.12, newOutputSize?: number): NeuralNet {
    const perturb = (x: number) =>
      x + (Math.random() < rate ? (Math.random() - 0.5) * 0.8 : 0);

    const outSize = newOutputSize ?? this.outputSize;
    const w2 = outSize === this.outputSize
      ? this.w2.map(row => row.map(perturb))
      : NeuralNet.randMatrix(outSize, this.hiddenSize, 1.0);
    const b2 = outSize === this.outputSize
      ? this.b2.map(perturb)
      : NeuralNet.randVec(outSize, 0.1);

    return new NeuralNet(this.inputSize, this.hiddenSize, outSize, {
      w1: this.w1.map(row => row.map(perturb)),
      b1: this.b1.map(perturb),
      w2,
      b2,
    });
  }

  serialize() {
    return { w1: this.w1, b1: this.b1, w2: this.w2, b2: this.b2 };
  }

  static deserialize(inputSize: number, hiddenSize: number, outputSize: number, data: ReturnType<NeuralNet['serialize']>): NeuralNet {
    return new NeuralNet(inputSize, hiddenSize, outputSize, data);
  }

  private static randMatrix(rows: number, cols: number, scale: number): number[][] {
    return Array.from({ length: rows }, () =>
      Array.from({ length: cols }, () => (Math.random() - 0.5) * 2 * scale),
    );
  }

  private static randVec(size: number, scale: number): number[] {
    return Array.from({ length: size }, () => (Math.random() - 0.5) * 2 * scale);
  }
}
