export type Input = string | number | Uint8Array | bigint | List | null

const txt = {
  // @ts-ignore
  TextEncoder: typeof TextEncoder === 'undefined' ? require('util').TextEncoder : TextEncoder,
}

// Use interface extension instead of type alias to
// make circular declaration possible.
export interface List extends Array<Input> {}

export interface Decoded {
  data: Uint8Array | Uint8Array[]
  remainder: Uint8Array
}

function hexToBytes(hex: string) {
  hex = hex.startsWith('0x') ? hex.slice(2) : hex
  hex = hex.length & 1 ? `0${hex}` : hex
  hex = Number(hex) === 0 ? '' : hex
  const len = hex.length
  const result = new Uint8Array(len / 2)
  for (let i = 0, j = 0; i < len - 1; i += 2, j++) {
    result[j] = parseInt(hex[i] + hex[i + 1], 16)
  }
  return result
}

function numberToBytes(num: number | bigint) {
  return hexToBytes(num.toString(16))
}

function utf8ToBytes(utf: string): Uint8Array {
  // @ts-ignore
  return new txt.TextEncoder().encode(utf)
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  if (arrays.length === 1) return arrays[0]
  const length = arrays.reduce((a, arr) => a + arr.length, 0)
  const result = new Uint8Array(length)
  for (let i = 0, pad = 0; i < arrays.length; i++) {
    const arr = arrays[i]
    result.set(arr, pad)
    pad += arr.length
  }
  return result
}

function bytesToHex(uint8a: Uint8Array): string {
  // pre-caching chars could speed this up 6x.
  let hex = ''
  for (let i = 0; i < uint8a.length; i++) {
    hex += uint8a[i].toString(16).padStart(2, '0')
  }
  return hex
}

/** Check if a string is prefixed by 0x */
function isHexPrefixed(str: string): boolean {
  return str.slice(0, 2) === '0x'
}

/** Removes 0x from a given String */
function stripHexPrefix(str: string): string {
  if (typeof str !== 'string') {
    return str
  }
  return isHexPrefixed(str) ? str.slice(2) : str
}

/** Transform an integer into its hexadecimal value */
function numberToHexSigned(integer: number): string {
  if (integer < 0) {
    throw new Error('Invalid integer as argument, must be unsigned!')
  }
  const hex = integer.toString(16)
  return hex.length % 2 ? `0${hex}` : hex
}

/** Transform an integer into a Uint8Array */
function numberToBytesSigned(integer: number): Uint8Array {
  return hexToBytes(numberToHexSigned(integer))
}

/** Pad a string to be even */
function padToEven(a: string): string {
  return a.length % 2 ? `0${a}` : a
}

/**
 * RLP Encoding based on: https://github.com/ethereum/wiki/wiki/%5BEnglish%5D-RLP
 * This function takes in a data, convert it to buffer if not, and a length for recursion
 * @param input - will be converted to buffer
 * @returns returns buffer of encoded data
 **/
export function encode(input: Input): Uint8Array {
  if (Array.isArray(input)) {
    const output: Uint8Array[] = []
    for (let i = 0; i < input.length; i++) {
      output.push(encode(input[i]))
    }
    const buf = concatBytes(...output)
    return concatBytes(...[encodeLength(buf.length, 192), buf])
  } else {
    const inputBuf = toBuffer(input)
    return inputBuf.length === 1 && inputBuf[0] < 128
      ? inputBuf
      : concatBytes(...[encodeLength(inputBuf.length, 128), inputBuf])
  }
}

/**
 * Parse integers. Check if there is no leading zeros
 * @param v The value to parse
 * @param base The base to parse the integer into
 */
function safeParseInt(v: Uint8Array, base: number): number {
  const vv = bytesToHex(v)
  if (vv.slice(0, 2) === '00') {
    throw new Error('invalid RLP: extra zeros')
  }
  return Number.parseInt(vv, base)
}

function encodeLength(len: number, offset: number): Uint8Array {
  if (len < 56) {
    return Uint8Array.from([len + offset])
  } else {
    const hexLength = numberToHexSigned(len)
    const lLength = hexLength.length / 2
    const firstByte = numberToHexSigned(offset + 55 + lLength)
    return hexToBytes(firstByte + hexLength)
  }
}

/**
 * RLP Decoding based on: {@link https://github.com/ethereum/wiki/wiki/%5BEnglish%5D-RLP|RLP}
 * @param input - will be converted to Uint8Array
 * @param stream - Is the input a stream (false by default)
 * @returns - returns decode Array of Uint8Arrays containg the original message
 **/
export function decode(input: Uint8Array, stream?: boolean): Uint8Array
export function decode(input: Uint8Array[], stream?: boolean): Uint8Array[]
export function decode(input: Input, stream?: boolean): Uint8Array[] | Uint8Array | Decoded
export function decode(input: Input, stream: boolean = false): Uint8Array[] | Uint8Array | Decoded {
  if (!input || (<any>input).length === 0) {
    return Uint8Array.from([])
  }

  const inputBuffer = toBuffer(input)
  const decoded = _decode(inputBuffer)

  if (stream) {
    return decoded
  }
  if (decoded.remainder.length !== 0) {
    throw new Error('invalid remainder')
  }

  return decoded.data
}

/**
 * Get the length of the RLP input
 * @param input
 * @returns The length of the input or an empty Buffer if no input
 */
export function getLength(input: Input): Uint8Array | number {
  if (!input || (<any>input).length === 0) {
    return Uint8Array.from([])
  }

  const inputBuffer = toBuffer(input)
  const firstByte = inputBuffer[0]

  if (firstByte <= 0x7f) {
    return inputBuffer.length
  } else if (firstByte <= 0xb7) {
    return firstByte - 0x7f
  } else if (firstByte <= 0xbf) {
    return firstByte - 0xb6
  } else if (firstByte <= 0xf7) {
    // a list between  0-55 bytes long
    return firstByte - 0xbf
  } else {
    // a list  over 55 bytes long
    const llength = firstByte - 0xf6
    const length = safeParseInt(inputBuffer.slice(1, llength), 16)
    return llength + length
  }
}

/** Decode an input with RLP */
function _decode(input: Uint8Array): Decoded {
  let length, llength, data, innerRemainder, d
  const decoded = []
  const firstByte = input[0]

  if (firstByte <= 0x7f) {
    // a single byte whose value is in the [0x00, 0x7f] range, that byte is its own RLP encoding.
    return {
      data: input.slice(0, 1),
      remainder: input.slice(1),
    }
  } else if (firstByte <= 0xb7) {
    // string is 0-55 bytes long. A single byte with value 0x80 plus the length of the string followed by the string
    // The range of the first byte is [0x80, 0xb7]
    length = firstByte - 0x7f

    // set 0x80 null to 0
    if (firstByte === 0x80) {
      data = Uint8Array.from([])
    } else {
      data = input.slice(1, length)
    }

    if (length === 2 && data[0] < 0x80) {
      throw new Error('invalid rlp encoding: byte must be less 0x80')
    }

    return {
      data: data,
      remainder: input.slice(length),
    }
  } else if (firstByte <= 0xbf) {
    llength = firstByte - 0xb6
    length = safeParseInt(input.slice(1, llength), 16)
    data = input.slice(llength, length + llength)
    if (data.length < length) {
      throw new Error('invalid RLP')
    }

    return {
      data: data,
      remainder: input.slice(length + llength),
    }
  } else if (firstByte <= 0xf7) {
    // a list between  0-55 bytes long
    length = firstByte - 0xbf
    innerRemainder = input.slice(1, length)
    while (innerRemainder.length) {
      d = _decode(innerRemainder)
      decoded.push(d.data as Uint8Array)
      innerRemainder = d.remainder
    }

    return {
      data: decoded,
      remainder: input.slice(length),
    }
  } else {
    // a list  over 55 bytes long
    llength = firstByte - 0xf6
    length = safeParseInt(input.slice(1, llength), 16)
    const totalLength = llength + length
    if (totalLength > input.length) {
      throw new Error('invalid rlp: total length is larger than the data')
    }

    innerRemainder = input.slice(llength, totalLength)
    if (innerRemainder.length === 0) {
      throw new Error('invalid rlp, List has a invalid length')
    }

    while (innerRemainder.length) {
      d = _decode(innerRemainder)
      decoded.push(d.data as Uint8Array)
      innerRemainder = d.remainder
    }
    return {
      data: decoded,
      remainder: input.slice(totalLength),
    }
  }
}

/** Transform anything into a Buffer */
function toBuffer(v: Input): Uint8Array {
  if (!(v instanceof Uint8Array)) {
    if (typeof v === 'string') {
      if (isHexPrefixed(v)) {
        return hexToBytes(padToEven(stripHexPrefix(v)))
      } else {
        return utf8ToBytes(v)
      }
    } else if (typeof v === 'number') {
      if (!v) {
        return Uint8Array.from([])
      } else {
        return numberToBytesSigned(v)
      }
    } else if (v === null || v === undefined) {
      return Uint8Array.from([])
    } else if (v instanceof Uint8Array) {
      return Uint8Array.from(v as any)
    } else if (typeof v === 'bigint') {
      // converts a BN to a Uint8Array
      return numberToBytes(v)
    } else {
      throw new Error('invalid type')
    }
  }
  return v
}
