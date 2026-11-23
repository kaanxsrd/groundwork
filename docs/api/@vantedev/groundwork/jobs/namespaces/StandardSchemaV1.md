# StandardSchemaV1

## Interfaces

### FailureResult

#### Properties

##### issues

> `readonly` **issues**: readonly [`Issue`](#issue)[]

***

### Issue

#### Properties

##### message

> `readonly` **message**: `string`

##### path?

> `readonly` `optional` **path?**: readonly (`PropertyKey` \| [`PathSegment`](#pathsegment))[]

***

### Options

#### Properties

##### libraryOptions?

> `readonly` `optional` **libraryOptions?**: `Record`\<`string`, `unknown`\>

***

### PathSegment

#### Properties

##### key

> `readonly` **key**: `PropertyKey`

***

### Props

#### Type Parameters

##### Input

`Input` = `unknown`

##### Output

`Output` = `Input`

#### Properties

##### types?

> `readonly` `optional` **types?**: [`Types`](#types-1)\<`Input`, `Output`\>

##### validate

> `readonly` **validate**: (`value`, `options?`) => [`Result`](#result)\<`Output`\> \| `Promise`\<[`Result`](#result)\<`Output`\>\>

###### Parameters

###### value

`unknown`

###### options?

[`Options`](#options)

###### Returns

[`Result`](#result)\<`Output`\> \| `Promise`\<[`Result`](#result)\<`Output`\>\>

##### vendor

> `readonly` **vendor**: `string`

##### version

> `readonly` **version**: `1`

***

### SuccessResult

#### Type Parameters

##### Output

`Output`

#### Properties

##### issues?

> `readonly` `optional` **issues?**: `undefined`

##### value

> `readonly` **value**: `Output`

***

### Types

#### Type Parameters

##### Input

`Input` = `unknown`

##### Output

`Output` = `Input`

#### Properties

##### input

> `readonly` **input**: `Input`

##### output

> `readonly` **output**: `Output`

## Type Aliases

### InferInput

> **InferInput**\<`Schema`\> = `NonNullable`\<`Schema`\[`"~standard"`\]\[`"types"`\]\>\[`"input"`\]

#### Type Parameters

##### Schema

`Schema` *extends* [`StandardSchemaV1`](../README.md#standardschemav1)

***

### InferOutput

> **InferOutput**\<`Schema`\> = `NonNullable`\<`Schema`\[`"~standard"`\]\[`"types"`\]\>\[`"output"`\]

#### Type Parameters

##### Schema

`Schema` *extends* [`StandardSchemaV1`](../README.md#standardschemav1)

***

### Result

> **Result**\<`Output`\> = [`SuccessResult`](#successresult)\<`Output`\> \| [`FailureResult`](#failureresult)

#### Type Parameters

##### Output

`Output`
