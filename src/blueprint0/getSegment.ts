import * as _ from 'underscore'
import * as objectPath from 'object-path'
import {
	SegmentContext, IngestSegment, BlueprintResultSegment, IBlueprintSegment, BlueprintResultPart, IngestPart, IBlueprintPart, IBlueprintPiece, IBlueprintAdLibPiece, VTContent, CameraContent, GraphicsContent, SplitsContent, SourceLayerType, RemoteContent
} from 'tv-automation-sofie-blueprints-integration'
import { literal, isAdLibPiece } from '../common/util'
import { SourceLayer, CasparLLayer } from '../types/layers'
import { Piece, BoxProps, SegmentConf } from '../types/classes'
import { TSRTimelineObj, DeviceType, AtemTransitionStyle, TimelineObjCCGMedia, TimelineContentTypeCasparCg, SuperSourceBox } from 'timeline-state-resolver-types'
import { parseConfig } from './helpers/config'
import { parseSources } from './helpers/sources'
import { createContentGraphics, createContentVT, createContentCam } from './helpers/content'
import { getStudioName } from './helpers/studio'
import { createPieceVideo, createPieceCam, createPieceGraphic, createPieceGraphicOverlay, createPieceInTransition, createPieceScript, createPieceGeneric, createPieceOutTransition } from './helpers/pieces'
import { createEnableForTimelineObject } from './helpers/timeline'

export function getSegment (context: SegmentContext, ingestSegment: IngestSegment): BlueprintResultSegment {
	const config: SegmentConf = {
		context: context,
		config: parseConfig(context),
		sourceConfig: parseSources(context, parseConfig(context))
	}
	const segment = literal<IBlueprintSegment>({
		name: ingestSegment.name,
		metaData: {}
	})
	const parts: BlueprintResultPart[] = []
	const screenWidth = 1920 // TODO: get from Sofie
	const screenHeight = 1080

	if (ingestSegment.payload['float']) {
		return {
			segment,
			parts
		}
	}

	for (const part of ingestSegment.parts) {
		if (!part.payload) {
			// TODO
			context.warning(`Missing payload for part: '${part.name || part.externalId}'`)
		} else if (part.payload['float']) {
			continue
		} else {
			const type = objectPath.get(part.payload, 'type', '') + ''
			if (!type) {
				context.warning(`Missing type for part: '${part.name || part.externalId}'`)
				parts.push(createGeneric(part))
			} else {
				let pieces: IBlueprintPiece[] = []
				let adLibPieces: IBlueprintAdLibPiece[] = []
				if ('pieces' in part.payload) {
					let pieceList = part.payload['pieces'] as Piece[]

					// Generate script
					let script = ''
					if ('script' in part.payload) {
						script += part.payload['script']
					}
					pieceList.forEach(piece => {
						if (piece.script) {
							script += `\n${piece.script}`
						}
					})

					if (type.match(/dve/i)) {
						let length = 0

						for (let i = 0; i < pieceList.length; i++) {
							if (!pieceList[i].objectType.match(/(transition)|(split)/i)) {
								length++
							}
						}

						if (length > 5) {
							// TODO: Report this to spreadsheet
							context.warning('Maximum number of elements in DVE is 4')
						} else if (length < 2) {
							context.warning('Minimum number of elements in DVE is 2')
						} else {
							let sources = Math.min(length, 4)
							let p = createDVE(config, pieceList, sources, screenWidth, screenHeight)
							if (isAdLibPiece(p)) {
								adLibPieces.push(p as IBlueprintAdLibPiece)
							} else {
								pieces.push(p as IBlueprintPiece)
							}
						}
					} else {
						let transitionType = AtemTransitionStyle.CUT

						for (let i = 0; i < pieceList.length; i++) {
							if (pieceList[i].objectType.match(/transition/i)) {
								transitionType = transitionTypeFromString(pieceList[i].attributes['attr0'])
							}
						}

						// Iterate over pieces + generate.
						for (let i = 0; i < pieceList.length; i++) {
							let piece = pieceList[i]
							switch (piece.objectType) {
								case 'video':
									createPieceByType(config, piece, createPieceVideo, pieces, adLibPieces, type, transitionType)
									break
								case 'camera':
									createPieceByType(config, piece, createPieceCam, pieces, adLibPieces, type, transitionType)
									break
								case 'graphic':
									createPieceByType(config, piece, createPieceGraphic, pieces, adLibPieces, type, transitionType)
									break
								case 'overlay':
									createPieceByType(config, piece, createPieceGraphicOverlay, pieces,adLibPieces, type, transitionType)
									break
								case 'transition':
									pieces.push(createPieceInTransition(piece, transitionType, piece.duration || 1000))
									break
								default:
									context.warning(`Missing objectType '${piece.objectType}' for piece: '${piece.clipName || piece.id}'`)
									break
							}

							if (i === 0 && script) {
								pieces.push(createPieceScript(piece, script))
							}
						}
					}
				}
				parts.push(createPart(part, pieces, adLibPieces))
			}
		}
	}

	return {
		segment,
		parts
	}
}

/**
 * Returns the AtemTransitionStyle represented by a string.
 * If no match is found, CUT is returned.
 * @param {string} str Transtion style to match.
 */
function transitionTypeFromString (str: string): AtemTransitionStyle {
	if (str.match(/mix/i)) {
		return AtemTransitionStyle.MIX
	} else if (str.match(/dip/i)) {
		return AtemTransitionStyle.DIP
	} else if (str.match(/wipe/i)) {
		return AtemTransitionStyle.WIPE
	} else if (str.match(/dve/i)) {
		return AtemTransitionStyle.DVE
	} else if (str.match(/sting/i)) {
		return AtemTransitionStyle.STING
	} else {
		return AtemTransitionStyle.CUT
	}
}

/**
 * Creates a DVE Piece.
 * Currently only supports split, not PIP.
 * @param {Piece[]} pieces Pieces to insert into the DVE.
 * @param {number} sources Number of sources to display.
 * @param {number} width Screen width.
 * @param {number} height Screen height.
 */
function createDVE (config: SegmentConf, pieces: Piece[], sources: number, width: number, height: number): IBlueprintPiece | IBlueprintAdLibPiece {
	let dvePiece = pieces[0] // First piece is always assumed to be the DVE.
	pieces = pieces.slice(1, sources + 1)
	let boxes: BoxProps[] = []
	// Right now there are always half the width/height, but could change!
	let boxWidth = 0
	let boxHeight = 0

	switch (sources) {
		case 2:
			boxWidth = width / 2
			boxHeight = height / 2
			boxes = [
				{
					x: -boxWidth,
					y: boxHeight,
					size: boxWidth
				},
				{
					x: 0,
					y: boxHeight,
					size: boxWidth
				}
			]
			break
		case 3:
			boxWidth = width / 2
			boxHeight = height / 2
			boxes = [
				{
					x: -(boxWidth / 2),
					y: boxHeight,
					size: boxWidth
				},
				{
					x: -boxWidth,
					y: 0,
					size: boxWidth
				},
				{
					x: 0,
					y: 0,
					size: boxWidth
				}
			]
			break
		case 4:
			boxWidth = width / 2
			boxHeight = height / 2
			boxes = [
				{
					x: -boxWidth,
					y: boxHeight,
					size: boxWidth
				},
				{
					x: 0,
					y: boxHeight,
					size: boxWidth
				},
				{
					x: -boxWidth,
					y: 0,
					size: boxWidth
				},
				{
					x: 0,
					y: 0,
					size: boxWidth
				}
			]
			break
	}

	let sourceBoxes: SuperSourceBox[] = []

	for (let i = 0; i < sources; i++) {
		sourceBoxes.push(literal<SuperSourceBox>({
			enabled: true,
			source: 1000, // TODO: Get this from Sofie.
			x: boxes[i].x,
			y: boxes[i].y,
			size: boxes[i].size
		}))
	}

	interface SourceMeta {
		type: SourceLayerType
		studioLabel: string
		switcherInput: number | string
	}

	let sourceConfigurations: Array<(VTContent | CameraContent | RemoteContent | GraphicsContent) & SourceMeta> = []

	pieces.forEach(piece => {
		let newContent: (VTContent | CameraContent | RemoteContent | GraphicsContent) & SourceMeta
		switch (piece.objectType) {
			case 'graphic':
				newContent = literal<GraphicsContent & SourceMeta>({...createContentGraphics(piece), ...{
					type: SourceLayerType.GRAPHICS,
					studioLabel: getStudioName(config.context),
					switcherInput: 1000 // TODO: Get from Sofie.
				}})
				newContent.timelineObjects = _.compact<TSRTimelineObj>([
					literal<TimelineObjCCGMedia>({
						id: '',
						enable: createEnableForTimelineObject(piece),
						priority: 1,
						layer: CasparLLayer.CasparCGGraphics,
						content: {
							deviceType: DeviceType.CASPARCG,
							type: TimelineContentTypeCasparCg.MEDIA,
							file: piece.clipName
						}
					})
				]),
				sourceConfigurations.push(newContent)
				break
			case 'video':
				newContent = literal<VTContent & SourceMeta>({...createContentVT(piece), ...{
					type: SourceLayerType.VT,
					studioLabel: getStudioName(config.context),
					switcherInput: 1000 // TODO: Get from Sofie.
				}})
				newContent.timelineObjects = _.compact<TSRTimelineObj>([
					literal<TimelineObjCCGMedia>({
						id: '',
						enable: createEnableForTimelineObject(piece),
						priority: 1,
						layer: CasparLLayer.CasparPlayerClip,
						content: {
							deviceType: DeviceType.CASPARCG,
							type: TimelineContentTypeCasparCg.MEDIA,
							file: piece.clipName
						}
					})
				]), // TODO
				sourceConfigurations.push(newContent)
				break
			case 'camera':
				newContent = literal<CameraContent & SourceMeta>({...createContentCam(config, piece), ...{
					type: SourceLayerType.CAMERA,
					studioLabel: getStudioName(config.context),
					switcherInput: 1000 // TODO: Get from Sofie.
				}})
				newContent.timelineObjects = [], // TODO
				sourceConfigurations.push(newContent)
				break
			case 'remote':
				newContent = literal<RemoteContent & SourceMeta>({
					timelineObjects: [], // TODO
					type: SourceLayerType.REMOTE,
					studioLabel: getStudioName(config.context),
					switcherInput: 1000 // TODO: Get from Sofie.
				})
				sourceConfigurations.push(newContent)
				break
			default:
				config.context.warning(`DVE does not support objectType '${piece.objectType}' for piece: '${piece.clipName || piece.id}'`)
				break
		}
	})

	let p = createPieceGeneric(dvePiece)

	let content: SplitsContent = {
		dveConfiguration: {},
		boxSourceConfiguration: sourceConfigurations,
		timelineObjects: _.compact<TSRTimelineObj>([

		])
	}

	p.content = content
	p.name = `DVE: ${sources} split`

	return p
}

/**
 * Creates a piece using a given function.
 * @param {Piece} piece Piece to create.
 * @param {(config: SegmentConf, p: Piece, context: string, transition: AtemTransitionStyle) => IBlueprintPiece | IBlueprintAdLibPiece} creator Function for creating the piece.
 * @param {IBlueprintPiece[]} pieces Array of IBlueprintPiece to add regular pieces to.
 * @param {IBlueprintAdLibPiece[]} adLibPieces Array of IBlueprintAdLibPiece to add adLib pieces to.
 * @param {string} context The part type the piece belogs to e.g. 'HEAD'
 * @param {AtemTransitionsStyle} transitionType Type of transition to use.
 */
function createPieceByType (
		config: SegmentConf,
		piece: Piece, creator: (config: SegmentConf, p: Piece, context: string, transition: AtemTransitionStyle) => IBlueprintPiece | IBlueprintAdLibPiece,
		pieces: IBlueprintPiece[],
		adLibPieces: IBlueprintAdLibPiece[],
		context: string,
		transitionType?: AtemTransitionStyle
	) {
	let p = creator(config, piece, context, transitionType || AtemTransitionStyle.CUT)
	if (p.content) {
		if (isAdLibPiece(p)) {
			adLibPieces.push(p as IBlueprintAdLibPiece)
		} else {
			pieces.push(p as IBlueprintPiece)

			if (context.match(/titles/i) && piece.objectType.match(/(graphic)|(video)/i)) {
				pieces.push(createPieceOutTransition(piece, transitionType || AtemTransitionStyle.DIP, (1 / 50) * 150 * 1000)) // TODO: Use actual framerate
			}

			if (context.match(/breaker/i) && piece.objectType.match(/(graphic)|(video)/i)) {
				pieces.push(createPieceOutTransition(piece, transitionType || AtemTransitionStyle.DIP, (1 / 50) * 50 * 1000)) // TODO: Use actual framerate
			}

			if (context.match(/package/i) && piece.objectType.match(/video/i)) {
				pieces.push(createPieceInTransition(piece, transitionType || AtemTransitionStyle.MIX, (1 / 50) * 150 * 1000))
				pieces.push(createPieceOutTransition(piece, transitionType || AtemTransitionStyle.DIP, (1 / 50) * 50 * 1000)) // TODO: Use actual framerate
			}
		}
	}
}

/**
 * Creates a generic part. Only used as a placeholder for part types that have not been implemented yet.
 * @param {Piece} piece Piece to evaluate.
 */
function createGeneric (ingestPart: IngestPart): BlueprintResultPart {
	const part = literal<IBlueprintPart>({
		externalId: ingestPart.externalId,
		title: ingestPart.name || 'Unknown',
		metaData: {},
		typeVariant: '',
		expectedDuration: 5000
	})

	const piece = literal<IBlueprintPiece>({
		_id: '',
		externalId: ingestPart.externalId,
		name: part.title,
		enable: { start: 0, duration: 100 },
		outputLayerId: 'pgm0',
		sourceLayerId: SourceLayer.PgmCam
	})

	return {
		part,
		adLibPieces: [],
		pieces: [piece]
	}
}

/**
 * Creates a part from an ingest part and associated pieces.
 * @param {IngestPart} ingestPart Ingest part.
 * @param {IBlueprintPiece[]} pieces Array of pieces.
 */
function createPart (ingestPart: IngestPart, pieces: IBlueprintPiece[], adLibPieces: IBlueprintAdLibPiece[]): BlueprintResultPart {
	const part = literal<IBlueprintPart>({
		externalId: ingestPart.externalId,
		title: ingestPart.name || 'Unknown',
		metaData: {},
		typeVariant: '',
		expectedDuration: calculateExpectedDuration(pieces)
	})

	return {
		part,
		adLibPieces: adLibPieces,
		pieces: pieces
	}
}

/**
 * Calculates the expected duration of a part from component pieces.
 * @param {IBlueprintPiece[]} pieces Pieces to calculate duration for.
 */
function calculateExpectedDuration (pieces: IBlueprintPiece[]): number {
	let duration = 0

	pieces.forEach(piece => {
		duration += (piece.enable.duration as number) // This will get more complicated as more rules are added
	})

	return duration
}
