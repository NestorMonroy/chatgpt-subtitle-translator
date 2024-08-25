import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";

import { TranslationOutput } from "./translatorOutput.mjs";
import { TranslatorStructuredBase } from "./translatorStructuredBase.js";

const NestedPlaceholder = "nested_"

export class TranslatorStructuredObject extends TranslatorStructuredBase
{
    /**
     * @param {{from?: string, to: string}} language
     * @param {import("./translator.mjs").TranslationServiceContext} services
     * @param {Partial<import("./translator.mjs").TranslatorOptions>} [options]
     */
    constructor(language, services, options)
    {
        if (options.batchSizes[0] === 10 && options.batchSizes[1] === 100)
        {
            const reducedBatchSizes = [10, 20]
            console.warn("[TranslatorStructuredObject]", "--batch-sizes is to be reduced to", JSON.stringify(reducedBatchSizes))
            options.batchSizes = reducedBatchSizes
        }
        else if (options.batchSizes.some(x => x > 100))
        {
            throw new Error("[TranslatorStructuredObject] Batch sizes should not exceed 100")
        }

        super(language, services, options)
    }

    /**
     * @param {[string]} lines
     * @returns {Promise<TranslationOutput>}
     */
    async translatePrompt(lines)
    {
        if (lines.length === 1)
        {
            return await this.translateBaseFallback(lines)
        }
        // const text = lines.join("\n\n")
        /** @type {import('openai').OpenAI.Chat.ChatCompletionMessageParam} */
        // const userMessage = { role: "user", content: `Translate from given schema` }
        /** @type {import('openai').OpenAI.Chat.ChatCompletionMessageParam[]} */
        const systemMessage = this.systemInstruction ? [{ role: "system", content: `${this.systemInstruction}` }] : []
        const messages = [...systemMessage, ...this.options.initialPrompts, ...this.promptContext]
        const max_tokens = this.getMaxToken(lines)

        const structuredObject = {}
        for (const [key, value] of lines.entries())
        {
            if (value.includes("\\N"))
            {
                const nestedObject = {}
                for (const [nestedKey, nestedValue] of value.split("\\N").entries())
                {
                    nestedObject[nestedValue.replaceAll("\\", "").trim()] = z.string()
                }
                structuredObject[NestedPlaceholder + key] = z.object({ ...nestedObject })
            }
            else 
            {
                structuredObject[value.replaceAll("\\", "")] = z.string()
            }
        }
        const translationBatch = z.object({ ...structuredObject });

        try
        {
            let startTime = 0, endTime = 0
            startTime = Date.now()

            await this.services.cooler?.cool()

            const output = await this.services.openai.beta.chat.completions.parse({
                messages,
                ...this.options.createChatCompletionRequest,
                stream: false,
                response_format: zodResponseFormat(translationBatch, "translation_batch"),
                max_tokens
            })

            // console.log("[TranslatorStructuredObject]", output.choices[0].message.content)

            endTime = Date.now()

            const translation = output.choices[0].message

            function getLinesOutput() 
            {
                if (translation.refusal)
                {
                    return [translation.refusal]
                }
                else
                {
                    const parsed = output.choices[0].message.parsed
                    const linesOut = []

                    let expectedIndex = 0
                    for (const [key, value] of Object.entries(parsed))
                    {
                        if (key.startsWith(NestedPlaceholder))
                        {
                            let multilineOutput = []
                            for (const [nestedKey, nestedValue] of Object.entries(value))
                            {
                                multilineOutput.push(nestedValue)
                            }
                            linesOut.push(multilineOutput.join("\\N"))
                        }
                        else
                        {
                            const expectedKey = lines[expectedIndex]
                            if (key != expectedKey)
                            {
                                console.warn("[TranslatorStructuredObject]", "Unexpected key", "Expected", expectedKey, "Received", key)
                            }
                            const element = parsed[key];
                            linesOut.push(element)
                        }
                        expectedIndex++
                    }
                    return linesOut
                }
            }

            const linesOut = getLinesOutput()

            const translationOutput = new TranslationOutput(
                linesOut,
                output.usage.prompt_tokens,
                output.usage.completion_tokens,
                output.usage.total_tokens,
                output.choices[0].message.refusal
            )

            this.promptTokensUsed += translationOutput.promptTokens
            this.completionTokensUsed += translationOutput.completionTokens
            this.tokensProcessTimeMs += (endTime - startTime)

            return translationOutput
        } catch (error)
        {
            console.error("[TranslatorStructuredObject]", `Error ${error?.constructor?.name}`, error?.message)
            return await this.translateBaseFallback(lines)
        }
    }

    /**
     * @param {string[]} lines 
     */
    async translateBaseFallback(lines)
    {
        console.error("[TranslatorStructuredObject]", "Fallback to base mode")
        const optionsRestore = {}
        optionsRestore.stream = this.options.createChatCompletionRequest?.stream

        this.options.createChatCompletionRequest.stream = this.optionsBackup.stream
        
        const output = await super.translatePrompt(lines)
        
        this.options.createChatCompletionRequest.stream = optionsRestore.stream

        return output
    }
}