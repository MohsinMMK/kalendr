/* The block's editor side: three plain controls. The page itself is drawn by the PHP renderer, so the block needs no build step. */
( function ( blocks, element, blockEditor, components ) {
	var el = element.createElement;
	blocks.registerBlockType( 'kalendr/booking', {
		edit: function ( props ) {
			var attributes = props.attributes;
			return el(
				'div',
				blockEditor.useBlockProps(),
				el(
					blockEditor.InspectorControls,
					null,
					el(
						components.PanelBody,
						{ title: 'Booking' },
						el( components.TextControl, { label: 'Service (link name)', help: 'Leave empty for the whole booking page.', value: attributes.service, onChange: function ( value ) { props.setAttributes( { service: value } ); } } ),
						el( components.SelectControl, {
							label: 'Show as',
							value: attributes.mode,
							options: [ { label: 'On the page', value: 'inline' }, { label: 'Popup button', value: 'popup' }, { label: 'Floating button', value: 'floating' } ],
							onChange: function ( value ) { props.setAttributes( { mode: value } ); },
						} ),
						attributes.mode !== 'inline' ? el( components.TextControl, { label: 'Button text', value: attributes.label, onChange: function ( value ) { props.setAttributes( { label: value } ); } } ) : null
					)
				),
				el( 'p', null, 'Kalendr booking (' + ( attributes.service || 'whole page' ) + ', ' + attributes.mode + ')' )
			);
		},
		save: function () { return null; },
	} );
} )( window.wp.blocks, window.wp.element, window.wp.blockEditor, window.wp.components );
