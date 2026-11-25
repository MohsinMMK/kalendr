<?php
if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}
delete_option( 'kalendr_booking_origin' );
delete_option( 'kalendr_booking_business' );
