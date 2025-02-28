import $ from "jquery";
import {z} from "zod";

import * as loading from "../loading";

import * as helpers from "./helpers";

const stripe_response_schema = z.object({
    session: z.object({
        type: z.string(),
        stripe_payment_intent_id: z.string().optional(),
        status: z.string(),
        is_manual_license_management_upgrade_session: z.boolean().optional(),
        event_handler: z
            .object({
                status: z.string(),
                error: z
                    .object({
                        message: z.string(),
                    })
                    .optional(),
            })
            .optional(),
    }),
});

type StripeSession = z.infer<typeof stripe_response_schema>["session"];

function update_status_and_redirect(redirect_to: string): void {
    window.location.replace(redirect_to);
}

function show_error_message(message: string): void {
    $("#webhook-loading").hide();
    $("#webhook-error").show();
    $("#webhook-error").text(message);
}

function show_html_error_message(rendered_message: string): void {
    $("#webhook-loading").hide();
    $("#webhook-error").show();
    $("#webhook-error").html(rendered_message);
}

function handle_session_complete_event(session: StripeSession): void {
    let redirect_to = "";
    switch (session.type) {
        case "card_update_from_billing_page":
            redirect_to = "/billing/";
            break;
        case "card_update_from_upgrade_page":
            if (session.is_manual_license_management_upgrade_session) {
                redirect_to = "/upgrade/?manual_license_management=true";
            } else {
                redirect_to = "/upgrade/";
            }
            break;
    }
    update_status_and_redirect(redirect_to);
}

async function stripe_checkout_session_status_check(stripe_session_id: string): Promise<boolean> {
    const response: unknown = await $.get("/json/billing/event/status", {stripe_session_id});
    const response_data = stripe_response_schema.parse(response);

    if (response_data.session.status === "created") {
        return false;
    }
    if (response_data.session.event_handler!.status === "started") {
        return false;
    }
    if (response_data.session.event_handler!.status === "succeeded") {
        handle_session_complete_event(response_data.session);
        return true;
    }
    if (response_data.session.event_handler!.status === "failed") {
        show_error_message(response_data.session.event_handler!.error!.message);
        return true;
    }

    return false;
}

export function initialize_retry_with_another_card_link_click_handler(): void {
    $("#retry-with-another-card-link").on("click", (e) => {
        e.preventDefault();
        $("#webhook-error").hide();
        helpers.create_ajax_request(
            "/json/billing/session/start_retry_payment_intent_session",
            "restartsession",
            [],
            "POST",
            (response) => {
                const response_data = helpers.stripe_session_url_schema.parse(response);

                window.location.replace(response_data.stripe_session_url);
            },
        );
    });
}

export async function stripe_payment_intent_status_check(
    stripe_payment_intent_id: string,
): Promise<boolean> {
    const response: unknown = await $.get("/json/billing/event/status", {stripe_payment_intent_id});

    const response_schema = z.object({
        payment_intent: z.object({
            status: z.string(),
            event_handler: z
                .object({
                    status: z.string(),
                    error: z
                        .object({
                            message: z.string(),
                        })
                        .optional(),
                })
                .optional(),
            last_payment_error: z
                .object({
                    message: z.string(),
                })
                .optional(),
        }),
    });
    const response_data = response_schema.parse(response);

    switch (response_data.payment_intent.status) {
        case "requires_payment_method":
            if (response_data.payment_intent.event_handler!.status === "succeeded") {
                show_html_error_message(
                    response_data.payment_intent.last_payment_error!.message +
                        "<br>" +
                        'You can try adding <a id="retry-with-another-card-link"> another card or </a> or retry the upgrade.',
                );
                initialize_retry_with_another_card_link_click_handler();
                return true;
            }
            if (response_data.payment_intent.event_handler!.status === "failed") {
                show_error_message(response_data.payment_intent.event_handler!.error!.message);
                return true;
            }
            return false;
        case "succeeded":
            if (response_data.payment_intent.event_handler!.status === "succeeded") {
                helpers.redirect_to_billing_with_successful_upgrade();
                return true;
            }
            if (response_data.payment_intent.event_handler!.status === "failed") {
                show_error_message(response_data.payment_intent.event_handler!.error!.message);
                return true;
            }
            return false;
        default:
            return false;
    }
}

export async function check_status(): Promise<boolean> {
    if ($("#data").attr("data-stripe-session-id")) {
        return await stripe_checkout_session_status_check(
            $("#data").attr("data-stripe-session-id")!,
        );
    }
    return await stripe_payment_intent_status_check(
        $("#data").attr("data-stripe-payment-intent-id")!,
    );
}

async function start_status_polling(): Promise<void> {
    let completed = false;
    try {
        completed = await check_status();
    } catch {
        setTimeout(() => void start_status_polling(), 5000);
    }
    if (!completed) {
        setTimeout(() => void start_status_polling(), 5000);
    }
}

async function initialize(): Promise<void> {
    const form_loading = "#webhook-loading";
    const form_loading_indicator = "#webhook_loading_indicator";

    loading.make_indicator($(form_loading_indicator), {
        text: "Processing ...",
        abs_positioned: true,
    });
    $(form_loading).show();
    await start_status_polling();
}

$(() => {
    void initialize();
});
