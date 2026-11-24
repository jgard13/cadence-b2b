import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import {
  Form,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";

import { login } from "../../shopify.server";
import { loginErrorMessage } from "./error.server";

export const meta: MetaFunction = () => {
  return [
    { title: "CadenceB2B — Log in" },
    {
      name: "description",
      content:
        "Automated B2B recurring orders & overdue invoice protection for Shopify.",
    },
  ];
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const errors = loginErrorMessage(await login(request));

  return { errors };
};

export default function Index() {
  const { showForm } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const errors = actionData?.errors;
  const isSubmitting = navigation.state === "submitting";

  return (
    <main
      style={{
        minHeight: "100vh",
        width: "100%",
        boxSizing: "border-box",
        backgroundColor: "#f6f6f7",
        color: "#202223",
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, Helvetica, Arial, sans-serif',
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px 16px",
        margin: 0,
      }}
    >
      <style>{`
        html, body {
          margin: 0;
          padding: 0;
          background-color: #f6f6f7;
        }
        .cadence-login-input:focus {
          outline: none;
          border-color: #1f1f1f !important;
          box-shadow: 0 0 0 3px rgba(31, 31, 31, 0.12);
        }
        .cadence-login-button:hover:not(:disabled) {
          background-color: #303030 !important;
        }
        .cadence-login-footer a:hover {
          color: #202223 !important;
          text-decoration: underline !important;
        }
      `}</style>

      <section
        style={{
          width: "100%",
          maxWidth: "420px",
          backgroundColor: "#ffffff",
          border: "1px solid #e1e3e5",
          borderRadius: "12px",
          boxShadow: "0 4px 16px rgba(0, 0, 0, 0.06)",
          padding: "32px",
          boxSizing: "border-box",
        }}
      >
        <header style={{ marginBottom: "24px" }}>
          <h1
            style={{
              margin: "0 0 8px 0",
              fontSize: "24px",
              lineHeight: 1.25,
              fontWeight: 700,
              letterSpacing: "-0.02em",
              color: "#111213",
            }}
          >
            CadenceB2B
          </h1>
          <p
            style={{
              margin: 0,
              fontSize: "14px",
              lineHeight: 1.5,
              color: "#616a73",
            }}
          >
            Automated B2B recurring orders &amp; overdue invoice protection for
            Shopify.
          </p>
        </header>

        {showForm && (
          <Form method="post" style={{ display: "grid", gap: "16px" }}>
            <div style={{ display: "grid", gap: "6px" }}>
              <label
                htmlFor="shop"
                style={{
                  fontSize: "13px",
                  fontWeight: 600,
                  color: "#202223",
                }}
              >
                Shop domain
              </label>
              <input
                id="shop"
                className="cadence-login-input"
                type="text"
                name="shop"
                placeholder="my-store.myshopify.com"
                autoComplete="organization"
                required
                aria-invalid={Boolean(errors?.shop)}
                aria-describedby="shop-helper"
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: "10px 12px",
                  fontSize: "14px",
                  lineHeight: 1.4,
                  color: "#202223",
                  backgroundColor: "#ffffff",
                  border: errors?.shop
                    ? "1px solid #d72c0d"
                    : "1px solid #c9cccf",
                  borderRadius: "8px",
                  transition: "border-color 0.15s ease, box-shadow 0.15s ease",
                }}
              />
              <span
                id="shop-helper"
                style={{
                  fontSize: "12px",
                  lineHeight: 1.4,
                  color: errors?.shop ? "#d72c0d" : "#6d7175",
                }}
              >
                {errors?.shop ?? "e.g. my-store.myshopify.com"}
              </span>
            </div>

            <button
              className="cadence-login-button"
              type="submit"
              disabled={isSubmitting}
              style={{
                width: "100%",
                padding: "11px 16px",
                fontSize: "14px",
                fontWeight: 600,
                lineHeight: 1.4,
                color: "#ffffff",
                backgroundColor: isSubmitting ? "#4a4a4a" : "#1f1f1f",
                border: "none",
                borderRadius: "8px",
                cursor: isSubmitting ? "not-allowed" : "pointer",
                transition: "background-color 0.15s ease",
              }}
            >
              {isSubmitting ? "Logging in..." : "Log in"}
            </button>
          </Form>
        )}
      </section>

      <footer
        className="cadence-login-footer"
        style={{
          marginTop: "20px",
          fontSize: "12px",
          color: "#6d7175",
          display: "flex",
          alignItems: "center",
          gap: "8px",
          flexWrap: "wrap",
          justifyContent: "center",
        }}
      >
        <a
          href="https://cadenceb2b.app"
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: "#6d7175", textDecoration: "none" }}
        >
          cadenceb2b.app
        </a>
        <span aria-hidden="true">&middot;</span>
        <a
          href="mailto:support@cadenceb2b.app"
          style={{ color: "#6d7175", textDecoration: "none" }}
        >
          support@cadenceb2b.app
        </a>
      </footer>
    </main>
  );
}
