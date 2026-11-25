<?php
/**
 * Plugin Name:       Kalendr Booking
 * Description:       Show your Kalendr booking page on any WordPress page with a shortcode or a block.
 * Version:           1.0.0
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * License:           GPL-2.0-or-later
 * Text Domain:       kalendr-booking
 *
 * Shortcode: [kalendr_booking business="your-business" service="haircut" mode="inline"]
 *
 * It prints the same one-script embed that Kalendr's Share sheet gives you (feature 52): a mount element, then
 * `embed.js` from your Kalendr address with data attributes. The plugin stores two settings (your Kalendr address and
 * your business name) and nothing else. It makes no request itself and holds no secret.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

const KALENDR_BOOKING_MODES  = array( 'inline', 'popup', 'floating' );
const KALENDR_BOOKING_THEMES = array( 'auto', 'light', 'dark' );

/** Keeps only an https address (or http on this machine), without a path, so the script can only come from the site named. */
function kalendr_booking_clean_origin( $value ) {
	$value = trim( (string) $value );
	$parts = wp_parse_url( $value );
	if ( empty( $parts['scheme'] ) || empty( $parts['host'] ) ) {
		return '';
	}
	$local = in_array( $parts['host'], array( 'localhost', '127.0.0.1' ), true );
	if ( 'https' !== $parts['scheme'] && ! ( 'http' === $parts['scheme'] && $local ) ) {
		return '';
	}
	$port = isset( $parts['port'] ) ? ':' . (int) $parts['port'] : '';
	return $parts['scheme'] . '://' . $parts['host'] . $port;
}

/** A link-safe name: lowercase letters, numbers and single dashes. Anything else is dropped. */
function kalendr_booking_clean_slug( $value ) {
	$value = strtolower( trim( (string) $value ) );
	return preg_match( '/^[a-z0-9]+(?:-[a-z0-9]+)*$/', $value ) ? $value : '';
}

/**
 * The markup for one booking embed. Pure: it reads only what it is given, so it can be tested without WordPress.
 *
 * @param array  $atts   business, service, mode, theme, brand (hex without #), label, position.
 * @param string $origin The Kalendr address, already cleaned.
 * @param int    $index  1 for the first embed on a page, 2 for the next, so mount ids never repeat.
 */
function kalendr_booking_markup( $atts, $origin, $index ) {
	$business = kalendr_booking_clean_slug( isset( $atts['business'] ) ? $atts['business'] : '' );
	if ( '' === $origin || '' === $business ) {
		return '';
	}
	$mode = in_array( isset( $atts['mode'] ) ? $atts['mode'] : '', KALENDR_BOOKING_MODES, true ) ? $atts['mode'] : 'inline';
	$mount_id = 'kalendr-booking-' . (int) $index;
	$attributes = array(
		'src'                    => $origin . '/embed.js',
		'data-kalendr-business'  => $business,
		'data-kalendr-mode'      => $mode,
	);
	$service = kalendr_booking_clean_slug( isset( $atts['service'] ) ? $atts['service'] : '' );
	if ( '' !== $service ) {
		$attributes['data-kalendr-service'] = $service;
	}
	if ( 'floating' !== $mode ) {
		$attributes['data-kalendr-mount'] = '#' . $mount_id;
	}
	if ( isset( $atts['theme'] ) && in_array( $atts['theme'], KALENDR_BOOKING_THEMES, true ) && 'auto' !== $atts['theme'] ) {
		$attributes['data-kalendr-theme'] = $atts['theme'];
	}
	if ( isset( $atts['brand'] ) && preg_match( '/^[0-9a-fA-F]{6}$/', $atts['brand'] ) ) {
		$attributes['data-kalendr-brand'] = strtolower( $atts['brand'] );
	}
	if ( 'inline' !== $mode && ! empty( $atts['label'] ) ) {
		$attributes['data-kalendr-label'] = mb_substr( wp_strip_all_tags( $atts['label'] ), 0, 40 );
	}
	if ( 'floating' === $mode && isset( $atts['position'] ) && 'left' === $atts['position'] ) {
		$attributes['data-kalendr-position'] = 'left';
	}
	$html = '';
	if ( 'floating' !== $mode ) {
		$html .= '<div id="' . esc_attr( $mount_id ) . '"></div>';
	}
	$pairs = '';
	foreach ( $attributes as $name => $value ) {
		$pairs .= ' ' . $name . '="' . esc_attr( $value ) . '"';
	}
	return $html . '<script' . $pairs . ' defer></script>';
}

function kalendr_booking_render( $atts ) {
	static $count = 0;
	$atts = shortcode_atts(
		array(
			'business' => get_option( 'kalendr_booking_business', '' ),
			'service'  => '',
			'mode'     => 'inline',
			'theme'    => 'auto',
			'brand'    => '',
			'label'    => 'Book an appointment',
			'position' => 'right',
		),
		$atts,
		'kalendr_booking'
	);
	$origin = kalendr_booking_clean_origin( get_option( 'kalendr_booking_origin', '' ) );
	if ( '' === $origin || '' === kalendr_booking_clean_slug( $atts['business'] ) ) {
		// Only people who can fix it see why; visitors see nothing rather than a broken box.
		return current_user_can( 'manage_options' )
			? '<p class="kalendr-booking-notice">' . esc_html__( 'Kalendr Booking: set your Kalendr address and business name under Settings, Kalendr Booking.', 'kalendr-booking' ) . '</p>'
			: '';
	}
	$count++;
	return kalendr_booking_markup( $atts, $origin, $count );
}
add_shortcode( 'kalendr_booking', 'kalendr_booking_render' );

/** The block uses the same renderer, so the shortcode and the block always agree. */
function kalendr_booking_register_block() {
	register_block_type(
		__DIR__ . '/block',
		array( 'render_callback' => static function ( $attributes ) {
			return kalendr_booking_render( is_array( $attributes ) ? $attributes : array() );
		} )
	);
}
add_action( 'init', 'kalendr_booking_register_block' );

function kalendr_booking_register_settings() {
	register_setting( 'kalendr_booking', 'kalendr_booking_origin', array( 'type' => 'string', 'sanitize_callback' => 'kalendr_booking_clean_origin', 'default' => '' ) );
	register_setting( 'kalendr_booking', 'kalendr_booking_business', array( 'type' => 'string', 'sanitize_callback' => 'kalendr_booking_clean_slug', 'default' => '' ) );
}
add_action( 'admin_init', 'kalendr_booking_register_settings' );

function kalendr_booking_menu() {
	add_options_page( 'Kalendr Booking', 'Kalendr Booking', 'manage_options', 'kalendr-booking', 'kalendr_booking_settings_page' );
}
add_action( 'admin_menu', 'kalendr_booking_menu' );

function kalendr_booking_settings_page() {
	if ( ! current_user_can( 'manage_options' ) ) {
		return;
	}
	?>
	<div class="wrap">
		<h1><?php echo esc_html__( 'Kalendr Booking', 'kalendr-booking' ); ?></h1>
		<form method="post" action="options.php">
			<?php settings_fields( 'kalendr_booking' ); ?>
			<table class="form-table" role="presentation">
				<tr>
					<th scope="row"><label for="kalendr_booking_origin"><?php echo esc_html__( 'Your Kalendr address', 'kalendr-booking' ); ?></label></th>
					<td>
						<input type="url" class="regular-text" id="kalendr_booking_origin" name="kalendr_booking_origin" value="<?php echo esc_attr( get_option( 'kalendr_booking_origin', '' ) ); ?>" placeholder="https://app.kalendr.example" />
						<p class="description"><?php echo esc_html__( 'The address you open Kalendr at, without anything after it.', 'kalendr-booking' ); ?></p>
					</td>
				</tr>
				<tr>
					<th scope="row"><label for="kalendr_booking_business"><?php echo esc_html__( 'Business name in the link', 'kalendr-booking' ); ?></label></th>
					<td>
						<input type="text" class="regular-text" id="kalendr_booking_business" name="kalendr_booking_business" value="<?php echo esc_attr( get_option( 'kalendr_booking_business', '' ) ); ?>" placeholder="lotus-dental" />
						<p class="description"><?php echo esc_html__( 'The part after /book/ on your booking page.', 'kalendr-booking' ); ?></p>
					</td>
				</tr>
			</table>
			<?php submit_button(); ?>
		</form>
		<h2><?php echo esc_html__( 'Use it', 'kalendr-booking' ); ?></h2>
		<p><code>[kalendr_booking]</code> <?php echo esc_html__( 'shows your whole booking page. Add', 'kalendr-booking' ); ?> <code>service="haircut"</code> <?php echo esc_html__( 'for one service, or', 'kalendr-booking' ); ?> <code>mode="popup"</code> / <code>mode="floating"</code> <?php echo esc_html__( 'for a button.', 'kalendr-booking' ); ?></p>
	</div>
	<?php
}
