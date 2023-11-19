//
// Copyright (c) James Killick and contributors. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.
//

import { G, Marker, SVG, Svg } from '@svgdotjs/svg.js'
import { Participant, ParticipantTypes, ElementTypes, SequenceDiagram, NoteLocations, ArrowHeadTypes } from "./SequenceDiagram"
import { Options, DeepPartial, DiagramOptions, BackgroundPattern, Align, defaultColour } from './Options'
import { Dimensions } from './Dimensions'
import { drawLifeline, drawMessage, drawSelfMessage, drawText, drawTextBox } from './ElementRenderers'
import { sizeMessage, sizeSelfMessage, sizeTextBox } from './ElementSizers'

type Point = [number, number]
export type Points = Point[]

interface LifeLines {
    lifelines: Lifeline[]
    maxHeight: number
}

type ParticipantMap = Map<Participant, Lifeline>

export interface Lifeline {
    x: number
    dimensions: Dimensions
    spacing: Map<number, number>
    index: number
    participant?: Participant
}

export default class SequenceDiagramRenderer {
    private _options: DiagramOptions
    private _diagram: SequenceDiagram
    private _container: HTMLElement
    private _svg: Svg
    private _icons: any = {}
    private _markers: any = {}

    constructor (diagram: SequenceDiagram, container: HTMLElement, options: DeepPartial<DiagramOptions>) {
        if (!diagram) throw new Error("Invalid parameter: diagram must be specified")
        if (!container) throw new Error("Invalid parameter: container must be specified")
        
        this._container = container
        this._container.innerHTML = ''
        this._svg = SVG().addTo(container)

        this._diagram = diagram
        this._options = Options.From(options)

        this._icons.actor = this._svg
            .defs()
            .path("M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm2-3a2 2 0 1 1-4 0 2 2 0 0 1 4 0zm4 8c0 1-1 1-1 1H3s-1 0-1-1 1-4 6-4 6 3 6 4zm-1-.004c-.001-.246-.154-.986-.832-1.664C11.516 10.68 10.289 10 8 10c-2.29 0-3.516.68-4.168 1.332-.678.678-.83 1.418-.832 1.664h10z")
            .transform({scale: 1.5})

        this._markers[ArrowHeadTypes.closed] = this._svg.marker(10, 10, (m: Marker) => {
            m.polygon("0 0, 10 5, 0 10").attr({
                fill: defaultColour,
                stroke: defaultColour,
            })
        }).attr({refX: 10, refY: 5})
        
        this._markers[ArrowHeadTypes.open] = this._svg.marker(10, 10, (m: Marker) => {
            m.polyline("0 0, 10 5, 0 10").attr({
                fill: "none",
                stroke: defaultColour,
            })
        }).attr({refX: 10, refY: 5})
    }

    private static spaceLifeLines(lifelines: Lifeline[]) {
        for (let sourceIndex = 0; sourceIndex < lifelines.length; sourceIndex++) {
            const sourceLayout = lifelines[sourceIndex]
            const spacings = [...sourceLayout.spacing].sort()

            for (const [targetIndex, width] of spacings) {
                const targetLayout = lifelines[targetIndex]
                const scx = sourceLayout.x + sourceLayout.dimensions.cx
                const tcx = targetLayout.x + targetLayout.dimensions.cx
                const diff = width - Math.abs(tcx - scx) 
                if (diff > 0) {
                    // nudge right
                    for (let i = targetIndex; i < lifelines.length; i++) {
                        lifelines.at(i)!.x += diff
                    }
                }
            }
        }
    }

    private static setSpacing(lifelines: Lifeline[], sourceIndex: number, targetIndex: number, width: number) {
        const leftIndex = Math.min(sourceIndex, targetIndex)
        const rightIndex = Math.max(sourceIndex, targetIndex)
        const left = lifelines[leftIndex]
        if (width > (left.spacing.get(rightIndex) ?? 0)) {
            left.spacing.set(rightIndex, width)
        }
    }

    private createLifelines(): LifeLines {
        const lifelines: Lifeline[] = []
        let offsetX = 0
        let maxHeight = 0
    
        // push a fake left boundary
        lifelines.push({ x: 0, index: 0, spacing: new Map(), dimensions: new Dimensions(0, 0) })
    
        for (const participant of this._diagram.participants) {
            let el: G
            switch (participant.type) {
                case ParticipantTypes.lifeline: el = drawTextBox(this._svg, participant.alias, this._options.lifelines.textBoxOptions); break
                case ParticipantTypes.actor: el = drawTextBox(this._svg, participant.alias, this._options.lifelines.textBoxOptions); break
                //case ParticipantTypes.actor: el = drawActor(this._draw, participant.alias, this._renderer.icons.actor, this._options.lifelines.textBoxOptions); break
            }
    
            const bbox = el.bbox()
            el.remove()
            lifelines.push({
                x: offsetX,
                index: lifelines.length,
                spacing: new Map(),
                dimensions: new Dimensions(bbox.width, bbox.height),
                participant
            })

            maxHeight = Math.max(maxHeight, bbox.height)
            offsetX += bbox.width
        }
    
        // push a fake right boundary
        lifelines.push({ x: offsetX, index: lifelines.length, spacing: new Map(), dimensions: new Dimensions(0, 0) })
    
        SequenceDiagramRenderer.spaceLifeLines(lifelines)
        return { 
            lifelines,
            maxHeight
        }
    }

    private layoutElements(lifelines: Lifeline[], participantMap: ParticipantMap) {
        const getIndex = (p: Participant): number => participantMap.get(p)!.index

        let elementY = 0
        for (const element of this._diagram.elements) {
            switch (element.type) {
                case ElementTypes.message:
                    const isSelfMessage = element.source === element.target
                    const d = isSelfMessage
                        ? sizeSelfMessage(this._svg, element.text, this._options)
                        : sizeMessage(this._svg, element.text, this._options)

                    if (isSelfMessage) {
                        SequenceDiagramRenderer.setSpacing(lifelines, getIndex(element.source), participantMap.get(element.target)!.index + 1, d.width)
                    } else {
                        SequenceDiagramRenderer.setSpacing(lifelines, getIndex(element.source), participantMap.get(element.target)!.index, d.width)
                    }
                    elementY += d.height
                    break
                case ElementTypes.note:
                    const { overlap, textBoxOptions } = this._options.notes
                    const noteDimensions = sizeTextBox(this._svg, element.text, textBoxOptions)
                    const sourceIndex = getIndex(element.target[0])

                    switch (element.location) {
                        case (NoteLocations.leftOf): SequenceDiagramRenderer.setSpacing(lifelines, sourceIndex, sourceIndex - 1, noteDimensions.width); break
                        case (NoteLocations.rightOf): SequenceDiagramRenderer.setSpacing(lifelines, sourceIndex, sourceIndex + 1, noteDimensions.width); break
                        case (NoteLocations.over):
                            let targetIndex = sourceIndex
                            if (element.target.length === 1) {
                                SequenceDiagramRenderer.setSpacing(lifelines, targetIndex-1, targetIndex, noteDimensions.width / 2)
                                SequenceDiagramRenderer.setSpacing(lifelines, targetIndex, targetIndex+1, noteDimensions.width / 2)
                            } else {
                                targetIndex = getIndex(element.target[1])
                                SequenceDiagramRenderer.setSpacing(lifelines, sourceIndex, targetIndex, noteDimensions.width - 2 * overlap)
                            }
                            break;
                    }
                    elementY += noteDimensions.height
                    break
            }
        }

        return elementY
    }

    private renderLifelines(lifelines: Lifeline[], offsetY: number, maxHeight: number): G {
        const group = this._svg.group()
        for (const lifeline of lifelines.slice(1, lifelines.length - 1)) {
            const lifelineGroup = drawLifeline(group, lifeline, offsetY, this._icons.actor, this._options.lifelines)
            lifelineGroup.translate(lifeline.x, maxHeight - lifelineGroup.children()[1].bbox().height)
        }
        group.rect(1, 1).fill("none").stroke("none").move(0,0).front()
        return group
    }

    private renderElements(participantMap: ParticipantMap): G {
        const group = this._svg.group()
        let offsetY = 0

        for (const element of this._diagram.elements) {
            switch (element.type) {
                case ElementTypes.message:
                    const source = participantMap.get(element.source)!
                    const target = participantMap.get(element.target)!
                    const message = source === target
                        ? drawSelfMessage(group, this._markers, element, source, this._options.messages)
                        : drawMessage(group, this._markers, element, source, target, this._options.messages)

                    const left = source.index < target.index ? source : target
                    message.translate(left.x + left.dimensions.cx, offsetY)
                    offsetY += message.bbox().height
                    break
                case ElementTypes.note:
                    const noteSource = participantMap.get(element.target[0])!

                    switch (element.location) {
                        case NoteLocations.leftOf:
                            this._options.notes.textBoxOptions.textOptions.align = Align.right
                            const leftOfNote = drawTextBox(group, element.text, this._options.notes.textBoxOptions).move(0,0)
                            leftOfNote.addClass("jasd-note")
                            
                            leftOfNote.translate(noteSource.x + noteSource.dimensions.cx - leftOfNote.bbox().width, offsetY)
                            offsetY += leftOfNote.bbox().height ?? 0
                            break
                        case NoteLocations.over:
                            this._options.notes.textBoxOptions.textOptions.align = Align.middle
                            const source = participantMap.get(element.target[0])!
                            const target = element.target.length === 1
                                ? source
                                : participantMap.get(element.target[1])!
                            const minimumWidth = Math.abs(source.x + source.dimensions.cx - (target.x + target.dimensions.cx)) + 2 * this._options.notes.textBoxOptions.margin
                            const overNote = drawTextBox(group, element.text, this._options.notes.textBoxOptions, minimumWidth).move(0,0)
                            overNote.addClass("jasd-note")

                            if (element.target.length === 1) {
                                overNote.y(offsetY)
                                overNote.cx(source.x + source.dimensions.cx)
                            } else {
                                const left = source.x < target.x ? source : target
                                overNote.translate(left.x + left.dimensions.cx - this._options.notes.overlap, offsetY)
                            }
                            offsetY += overNote.bbox().height ?? 0
                            break
                        case NoteLocations.rightOf:
                            this._options.notes.textBoxOptions.textOptions.align = Align.left
                            const rightOfNote = drawTextBox(group, element.text, this._options.notes.textBoxOptions).move(0,0)
                            rightOfNote.addClass("jasd-note")
                            rightOfNote.translate(noteSource.x + noteSource.dimensions.cx, offsetY)
                            offsetY += rightOfNote.bbox().height ?? 0
                            break
                    }
                    break
            }
        }
        return group
    }

    private renderTitle(offsetX: number, offsetY: number, totalWidth: number): G {
        const group = this._svg.group()
        drawText(group, this._diagram.title ?? "", this._options.title.textOptions)
        
        switch (this._options.title.textOptions.align) {
            case Align.left:
                group.translate(offsetX, offsetY)
                break
            case Align.middle:
                group.translate(totalWidth / 2, offsetY)
                break
            case Align.right:
                group.translate(totalWidth - this._options.padding, offsetY)
                break
        }

        return group
    }

    private renderBackground(diagramWidth: number, diagramHeight: number) {
        const backgroundPattern = this._options.background as BackgroundPattern
        if (backgroundPattern && typeof backgroundPattern.pattern?.func === 'function') {
            const { pattern: { width: w, height: h, func } } = backgroundPattern
            const pattern = this._svg.pattern(w, h, func)
            this._svg.rect(diagramWidth, diagramHeight).fill(pattern).back()
        }

        if (this._options.background && typeof this._options.background === 'function') {
            const bgGroup = this._options.background(this._svg, diagramWidth, diagramHeight)
            bgGroup.back()
        }
    }

    render() {
        const { lifelines, maxHeight } = this.createLifelines()
        const participantMap = new Map<Participant, Lifeline>(lifelines.map(x => [x.participant!, x]))
        const elementY = this.layoutElements(lifelines, participantMap)

        // calc final lifeline spacing
        SequenceDiagramRenderer.spaceLifeLines(lifelines)

        // lifelines draw
        const lifelinesGroup = this.renderLifelines(lifelines, elementY, maxHeight)
        
        // elements draw
        const elementsGroup = this.renderElements(participantMap)
        
        const diagramWidth = lifelines.at(-1)!.x + 2 * this._options.padding
        let offsetX = this._options.padding
        let offsetY = this._options.padding

        // title draw
        if (this._diagram.title) {
            const titleGroup = this.renderTitle(offsetX, offsetY, diagramWidth)
            offsetY += titleGroup.bbox().height + this._options.title.paddingBottom
        }

        // shift groups to their locations
        lifelinesGroup.move(offsetX, offsetY)
        elementsGroup.move(offsetX, offsetY + maxHeight)
        
        // resize diagram
        const diagramHeight = offsetY + lifelinesGroup.bbox().height + this._options.padding
        this._svg.size(diagramWidth, diagramHeight)

        // draw background
        this.renderBackground(diagramWidth, diagramHeight)
        //this._renderer.draw.group().op
    }  
}