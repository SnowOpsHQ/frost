// The packaged self-test's built-in model (spec `intent-classifier.spec.ts`, `INTENT_SELFTEST_SWITCH`;
// acceptance `intent-classifier.feature.md`, Self-test): the smallest ONNX model that makes ONNX
// Runtime do real work, `y = x + x` over four floats, encoded here as protobuf bytes so the self-test
// needs no file and no download. It proves the packaged native runtime loads, creates a session and
// runs it in the utility process.

/** A protobuf varint. */
function varint(value: number): number[] {
  const bytes: number[] = [];
  let rest = value;
  while (rest > 0x7f) {
    bytes.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  bytes.push(rest);
  return bytes;
}

const VARINT = 0;
const LENGTH = 2;
const key = (field: number, wire: number): number[] => varint((field << 3) | wire);
const int = (field: number, value: number): number[] => [...key(field, VARINT), ...varint(value)];
const bytes = (field: number, content: readonly number[]): number[] => [...key(field, LENGTH), ...varint(content.length), ...content];
const text = (field: number, value: string): number[] => bytes(field, [...new TextEncoder().encode(value)]);

/** `TensorProto.DataType.FLOAT`. */
const FLOAT = 1;
export const SELFTEST_INPUT = 'x';
export const SELFTEST_OUTPUT = 'y';
export const SELFTEST_SIZE = 4;

/** A `ValueInfoProto` of a float tensor of shape `[SELFTEST_SIZE]`. */
const floatVector = (name: string): number[] => [...text(1, name), ...bytes(2, bytes(1, [...int(1, FLOAT), ...bytes(2, bytes(1, int(1, SELFTEST_SIZE)))]))];

/** `ModelProto`: IR version 8, the default opset 13, one graph with one `Add` node. */
export const SELFTEST_MODEL: Uint8Array = Uint8Array.from([
  ...int(1, 8),
  ...text(2, 'frost'),
  ...bytes(7, [
    ...bytes(1, [...text(1, SELFTEST_INPUT), ...text(1, SELFTEST_INPUT), ...text(2, SELFTEST_OUTPUT), ...text(3, 'double'), ...text(4, 'Add')]),
    ...text(2, 'selftest'),
    ...bytes(11, floatVector(SELFTEST_INPUT)),
    ...bytes(12, floatVector(SELFTEST_OUTPUT)),
  ]),
  ...bytes(8, int(2, 13)),
]);
